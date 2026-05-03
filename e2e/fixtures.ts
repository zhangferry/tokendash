import type { DailyEntry, DailyResponse, ProjectsResponse, BlocksResponse, BlockEntry, AnalyticsResponse } from '../src/shared/types.js';

// ---------------------------------------------------------------------------
// Date helpers — all dates are relative to "now" so tests work on any day
// ---------------------------------------------------------------------------

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(12, 0, 0, 0);
  return d;
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function fmtHour(d: Date): string {
  return d.toISOString().slice(0, 13).replace('T', ' ') + ':00';
}

function todayStr(): string {
  return fmtDate(new Date());
}

// ---------------------------------------------------------------------------
// Token value generators — deterministic but varied
// ---------------------------------------------------------------------------

function seededValue(seed: number): number {
  // Simple deterministic "random" based on seed
  return ((seed * 2654435761) >>> 0) % 100000;
}

// ---------------------------------------------------------------------------
// Daily entries
// ---------------------------------------------------------------------------

function makeDailyEntry(date: string, models: string[], seed: number): DailyEntry {
  const total = seededValue(seed);
  const inputRatio = 0.4;
  const outputRatio = 0.1;
  const cacheReadRatio = 0.5;

  const totalInput = Math.round(total * inputRatio);
  const totalOutput = Math.round(total * outputRatio);
  const totalCacheRead = Math.round(total * cacheReadRatio);

  const perModel = (val: number) => Math.round(val / models.length);

  return {
    date,
    inputTokens: totalInput,
    outputTokens: totalOutput,
    cacheCreationTokens: 0,
    cacheReadTokens: totalCacheRead,
    totalTokens: totalInput + totalOutput + totalCacheRead,
    totalCost: 0,
    modelsUsed: models,
    modelBreakdowns: models.map(name => ({
      modelName: name,
      inputTokens: perModel(totalInput),
      outputTokens: perModel(totalOutput),
      cacheCreationTokens: 0,
      cacheReadTokens: perModel(totalCacheRead),
      cost: 0,
    })),
  };
}

// ---------------------------------------------------------------------------
// Block (hourly) entries
// ---------------------------------------------------------------------------

function makeBlock(date: Date, hour: number, models: string[], idx: number): BlockEntry {
  const val = seededValue(idx * 100 + hour);
  const input = Math.round(val * 0.4);
  const output = Math.round(val * 0.1);
  const cacheRead = Math.round(val * 0.5);

  const d = fmtDate(date);
  const h = String(hour).padStart(2, '0');

  return {
    id: `block-${idx}`,
    startTime: `${d}T${h}:00:00`,
    endTime: `${d}T${h}:59:59`,
    actualEndTime: null,
    isActive: false,
    isGap: false,
    entries: 1,
    tokenCounts: {
      inputTokens: input,
      outputTokens: output,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: cacheRead,
    },
    totalTokens: input + output + cacheRead,
    costUSD: 0,
    models,
  };
}

// ---------------------------------------------------------------------------
// Per-agent fixture configuration
// ---------------------------------------------------------------------------

interface AgentConfig {
  models: string[];
  projects: { path: string; weight: number }[];
  hasAnalytics: boolean;
}

const AGENT_CONFIGS: Record<string, AgentConfig> = {
  claude: {
    models: ['claude-sonnet-4-5', 'claude-opus-4-5'],
    projects: [
      { path: '/Users/test/project-alpha', weight: 3 },
      { path: '/Users/test/project-beta', weight: 2 },
      { path: '/Users/test/project-gamma', weight: 1 },
    ],
    hasAnalytics: true,
  },
  opencode: {
    models: ['glm-4.7', 'mimo-v2.5-pro'],
    projects: [
      { path: '/Users/test/workspace-a/task-1/workdir', weight: 3 },
      { path: '/Users/test/workspace-b/task-2/workdir', weight: 2 },
      { path: '/Users/test/my-project', weight: 1 },
    ],
    hasAnalytics: false,
  },
  codex: {
    models: ['o3', 'o4-mini'],
    projects: [
      { path: '/Users/test/codex-project', weight: 2 },
    ],
    hasAnalytics: false,
  },
  openclaw: {
    models: ['gpt-4.1', 'gpt-4.1-mini'],
    projects: [
      { path: '/Users/test/openclaw-project', weight: 2 },
    ],
    hasAnalytics: true,
  },
};

// ---------------------------------------------------------------------------
// Fixture generators
// ---------------------------------------------------------------------------

const TOTAL_DAYS = 90; // enough for ALL range

export function generateDailyResponse(agent: string): DailyResponse {
  const config = AGENT_CONFIGS[agent] || AGENT_CONFIGS.claude;
  const daily: DailyEntry[] = [];

  for (let i = TOTAL_DAYS; i >= 0; i--) {
    const date = fmtDate(daysAgo(i));
    daily.push(makeDailyEntry(date, config.models, i + 1));
  }

  const totals = daily.reduce(
    (acc, d) => ({
      inputTokens: acc.inputTokens + d.inputTokens,
      outputTokens: acc.outputTokens + d.outputTokens,
      cacheCreationTokens: acc.cacheCreationTokens + d.cacheCreationTokens,
      cacheReadTokens: acc.cacheReadTokens + d.cacheReadTokens,
      totalTokens: acc.totalTokens + d.totalTokens,
      totalCost: acc.totalCost + d.totalCost,
    }),
    { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0, totalCost: 0 },
  );

  return { daily, totals };
}

export function generateProjectsResponse(agent: string): ProjectsResponse {
  const config = AGENT_CONFIGS[agent] || AGENT_CONFIGS.claude;
  const projects: Record<string, DailyEntry[]> = {};

  for (const proj of config.projects) {
    const entries: DailyEntry[] = [];
    // Distribute days across projects by weight
    const projDays = Math.round(TOTAL_DAYS * (proj.weight / config.projects.reduce((s, p) => s + p.weight, 0)));
    for (let i = projDays; i >= 0; i--) {
      const date = fmtDate(daysAgo(i));
      entries.push(makeDailyEntry(date, config.models, (i + 1) * 7));
    }
    projects[proj.path] = entries;
  }

  return { projects };
}

export function generateBlocksResponse(agent: string): BlocksResponse {
  const config = AGENT_CONFIGS[agent] || AGENT_CONFIGS.claude;
  const blocks: BlockEntry[] = [];
  let idx = 0;

  // Generate blocks: a few hours per day, every other day
  for (let day = TOTAL_DAYS; day >= 0; day--) {
    if (day % 2 !== 0 && day !== 0) continue; // skip odd days except today
    const d = daysAgo(day);
    // 3-5 activity hours per day
    const hours = day === 0 ? [9, 10, 11, 13, 14] : [9, 11, 14, 16, 20];
    for (const h of hours) {
      blocks.push(makeBlock(d, h, config.models, idx++));
    }
  }

  return { blocks };
}

export function generateAnalyticsResponse(agent: string): AnalyticsResponse | null {
  const config = AGENT_CONFIGS[agent] || AGENT_CONFIGS.claude;
  if (!config.hasAnalytics) return null;

  const codeChangeTrend = [];
  const toolCallTrend: Array<Record<string, string | number>> = [];
  const toolMap: Record<string, number> = { Read: 0, Edit: 0, Bash: 0, Grep: 0, Write: 0 };

  for (let i = 30; i >= 0; i--) {
    const date = fmtDate(daysAgo(i));
    const added = seededValue((i + 1) * 13);
    const deleted = Math.round(added * 0.6);
    codeChangeTrend.push({
      date,
      linesAdded: added,
      linesDeleted: deleted,
      netChange: added - deleted,
      filesModified: Math.round(added / 50),
    });

    const calls: Record<string, string | number> = { date };
    for (const tool of Object.keys(toolMap)) {
      const count = seededValue((i + 1) * 17 + toolMap[tool]++);
      calls[tool] = count;
      toolMap[tool] = (toolMap[tool] || 0) + count;
    }
    toolCallTrend.push(calls);
  }

  const toolUsageDistribution = Object.entries(toolMap)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  return {
    codeChangeTrend,
    toolUsageDistribution,
    productivityKPIs: {
      avgLinesPerEdit: 45,
      filesModifiedPerDay: 8,
      addDeleteRatio: 1.5,
      totalEdits: 500,
      totalFilesModified: 120,
      activeDaysWithEdits: 25,
    },
    toolCallTrend,
  };
}

// ---------------------------------------------------------------------------
// Agents detection response
// ---------------------------------------------------------------------------

export function generateAgentsResponse(agentList: string[] = ['claude', 'opencode', 'codex']) {
  return {
    available: agentList,
    default: agentList[0],
  };
}

// ---------------------------------------------------------------------------
// Route handler — intercepts all /api/* calls and returns fixture data
// ---------------------------------------------------------------------------

export interface FixtureOverrides {
  agents?: string[];
  // Allow selectively omitting data to test loading/error states
  emptyAgents?: boolean;
  noBlocks?: boolean;
}

export async function mockApiRoutes(
  page: import('@playwright/test').Page,
  overrides: FixtureOverrides = {},
) {
  const agentList = overrides.agents || ['claude', 'opencode', 'codex'];
  const cache = new Map<string, unknown>();

  function getOrGenerate(key: string, generator: () => unknown): unknown {
    if (!cache.has(key)) cache.set(key, generator());
    return cache.get(key);
  }

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace('/api/', '');
    const agent = url.searchParams.get('agent') || 'claude';

    switch (path) {
      case 'agents':
        if (overrides.emptyAgents) {
          await route.fulfill({ json: generateAgentsResponse([]) });
        } else {
          await route.fulfill({ json: getOrGenerate('agents', () => generateAgentsResponse(agentList)) });
        }
        break;

      case 'daily':
        await route.fulfill({
          json: getOrGenerate(`daily:${agent}`, () => generateDailyResponse(agent)),
        });
        break;

      case 'projects':
        await route.fulfill({
          json: getOrGenerate(`projects:${agent}`, () => generateProjectsResponse(agent)),
        });
        break;

      case 'blocks':
        if (overrides.noBlocks) {
          await route.fulfill({ json: { blocks: [] } });
        } else {
          await route.fulfill({
            json: getOrGenerate(`blocks:${agent}`, () => generateBlocksResponse(agent)),
          });
        }
        break;

      case 'analytics': {
        const analytics = getOrGenerate(`analytics:${agent}`, () => generateAnalyticsResponse(agent));
        if (analytics) {
          await route.fulfill({ json: analytics });
        } else {
          await route.fulfill({
            status: 200,
            json: {
              codeChangeTrend: [],
              toolUsageDistribution: [],
              productivityKPIs: { avgLinesPerEdit: 0, filesModifiedPerDay: 0, addDeleteRatio: 0, totalEdits: 0, totalFilesModified: 0, activeDaysWithEdits: 0 },
              toolCallTrend: [],
            },
          });
        }
        break;
      }

      default:
        await route.continue();
    }
  });
}
