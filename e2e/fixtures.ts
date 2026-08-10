import type { DailyEntry, DailyResponse, ProjectsResponse, BlocksResponse, BlockEntry, AnalyticsResponse, SessionAnalyticsResponse, SessionDetail, SessionSummary } from '../src/shared/types.js';

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
  pi: {
    models: ['qwen3.8-max-preview', 'claude-sonnet-4-5'],
    projects: [
      { path: 'D:\\file\\tokendash', weight: 3 },
      { path: 'D:\\file\\Zed', weight: 2 },
    ],
    hasAnalytics: false,
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

function sessionFor(agent: string, index: number): SessionSummary {
  const config = AGENT_CONFIGS[agent] || AGENT_CONFIGS.claude;
  const started = daysAgo(index % 28);
  started.setHours(9 + (index % 8), 15, 0, 0);
  const minutes = 8 + (index % 7) * 6;
  return {
    id: `ses_${agent}_${String(index).padStart(4, '0')}`,
    agent,
    project: config.projects[index % config.projects.length]?.path,
    title: `Session task ${index + 1}`,
    description: `${3 + (index % 8)} user turns · ${2 + (index % 5)} tool calls`,
    startedAt: started.toISOString(),
    endedAt: new Date(started.getTime() + minutes * 60_000).toISOString(),
    status: index === 0 ? 'active' : 'complete',
    models: [config.models[index % config.models.length]!],
    llmCallCount: 8 + (index % 9),
    ...(agent === 'codex' ? {} : { toolCallCount: 2 + (index % 5), userTurnCount: 3 + (index % 8) }),
    durationMs: minutes * 60_000,
    totalTokens: 24_000 + index * 900,
    totalCost: index / 100,
  };
}

export function generateSessionAnalyticsResponse(agent: string): SessionAnalyticsResponse {
  const config = AGENT_CONFIGS[agent] || AGENT_CONFIGS.claude;
  const sessions = Array.from({ length: 28 }, (_, index) => sessionFor(agent, index));
  const supportsEvents = agent !== 'codex' && agent !== 'opencode' && agent !== 'pi';
  const llmCallTrend = Array.from({ length: 8 }, (_, index) => {
    const date = fmtDate(daysAgo(7 - index));
    const first = 14 + index * 2;
    return { date, total: first + 8, models: { [config.models[0]!]: first, [config.models[1] || 'Other']: 8 } };
  });
  const durations = sessions.map(session => session.durationMs || 0);
  const avgUserTurnCount = supportsEvents ? sessions.reduce((sum, session) => sum + (session.userTurnCount || 0), 0) / sessions.length : undefined;
  return {
    summary: {
      sessionCount: sessions.length,
      llmCallCount: sessions.reduce((sum, session) => sum + session.llmCallCount, 0),
      ...(supportsEvents ? { toolCallCount: sessions.reduce((sum, session) => sum + (session.toolCallCount || 0), 0), skillCallCount: 18, avgUserTurnCount, longSessionRate: 22.7, toolSuccessRate: 96.8 } : {}),
      avgDurationMs: durations.reduce((sum, value) => sum + value, 0) / durations.length,
      medianDurationMs: durations.sort((a, b) => a - b)[Math.floor(durations.length / 2)],
    },
    llmCallTrend,
    ...(supportsEvents ? { skillDistribution: [{ name: 'frontend-design', count: 12 }, { name: 'implement', count: 6 }], toolDistribution: [{ name: 'Read', count: 42 }, { name: 'Edit', count: 31 }, { name: 'Bash', count: 19 }], userTurnDistribution: [{ bucket: '1–2', sessionCount: 4, percentage: 14.3 }, { bucket: '3–5', sessionCount: 8, percentage: 28.6 }, { bucket: '6–8', sessionCount: 10, percentage: 35.7 }, { bucket: '9–12', sessionCount: 6, percentage: 21.4 }] } : {}),
    durationTurnTrend: llmCallTrend.map((entry, index) => ({ date: entry.date, avgDurationMs: (16 + index * 2) * 60_000, ...(supportsEvents ? { avgUserTurnCount: 4 + index / 3 } : {}) })),
    sessions,
    pagination: {},
    capabilities: { userTurns: supportsEvents, skills: supportsEvents, tools: supportsEvents, toolResults: supportsEvents, contentPreview: false },
  };
}

export function generateSessionDetail(agent: string, id: string): SessionDetail {
  const session = sessionFor(agent, Number(id.match(/(\d+)$/)?.[1] || 0));
  session.id = id;
  return {
    session,
    indexedAt: new Date().toISOString(),
    capabilities: { userTurns: agent !== 'codex', skills: false, tools: agent !== 'codex', toolResults: agent !== 'codex', contentPreview: true },
    events: [
      { id: 'context-system-1', timestamp: new Date(Date.parse(session.startedAt) - 2000).toISOString(), type: 'input_context', inputKind: 'system', contextLabel: 'System prompt', summary: 'System input · System prompt', contentPreview: 'You are an AI coding assistant working inside the current workspace.', content: 'You are an AI coding assistant working inside the current workspace. Preserve user files and verify implementation changes before reporting completion.', contentAvailable: true },
      { id: 'context-runtime-1', timestamp: new Date(Date.parse(session.startedAt) - 1000).toISOString(), type: 'input_context', inputKind: 'runtime', contextLabel: 'AGENTS.md instructions', summary: 'Runtime input · AGENTS.md instructions', contentPreview: '# AGENTS.md instructions\nRun typecheck and e2e tests for session dashboard changes.', content: '# AGENTS.md instructions\nRun typecheck and e2e tests for session dashboard changes. Keep tool and Skill metrics semantically separate.', contentAvailable: true },
      { id: 'user-1', timestamp: session.startedAt, type: 'user_message', summary: 'User request', contentPreview: 'Review the dashboard’s session analytics detail and make the run history easier to inspect.', content: 'Review the dashboard’s session analytics detail and make the run history easier to inspect. Include the user input, tool arguments, tool results, and the final assistant response.', contentAvailable: true },
      { id: 'llm-1', timestamp: new Date(Date.parse(session.startedAt) + 4000).toISOString(), type: 'llm_call', model: session.models[0], summary: 'Model reasoning', contentPreview: 'I need to inspect the event model before deciding how the detail view should group requests, responses, and tool invocations.', content: 'I need to inspect the event model before deciding how the detail view should group requests, responses, and tool invocations. The reasoning must remain visible alongside the final model response.', contentAvailable: true, usage: { inputTokens: 2800, outputTokens: 1100, cacheReadTokens: 18600, totalTokens: 22500 } },
      { id: 'tool-1', callId: 'call-read-1', timestamp: new Date(Date.parse(session.startedAt) + 12_000).toISOString(), type: 'tool_call', toolName: 'Read', summary: 'Tool Read called', parameterSummary: 'Parameters { path: "src/client/Dashboard.tsx" }', contentAvailable: false },
      { id: 'result-1', callId: 'call-read-1', timestamp: new Date(Date.parse(session.startedAt) + 14_000).toISOString(), type: 'tool_result', toolName: 'Read', resultSummary: 'Result { 230 lines read }', success: true, contentAvailable: false },
      { id: 'assistant-1', timestamp: new Date(Date.parse(session.startedAt) + 30_000).toISOString(), type: 'assistant_message', model: session.models[0], summary: 'Final response', phase: 'final_answer', contentPreview: 'I traced the session detail flow and identified where the event metadata loses the meaningful request and response content.', content: 'I traced the session detail flow and identified where the event metadata loses the meaningful request and response content. The detail view should preserve safe previews and offer full text on demand.', contentAvailable: true },
      { id: 'user-2', timestamp: new Date(Date.parse(session.startedAt) + 60_000).toISOString(), type: 'user_message', summary: 'User request', contentPreview: 'Now verify that the next task keeps its own request, progress, and answer together.', content: 'Now verify that the next task keeps its own request, progress, and answer together without inheriting the first task’s activity.', contentAvailable: true },
      { id: 'assistant-2', timestamp: new Date(Date.parse(session.startedAt) + 64_000).toISOString(), type: 'assistant_message', model: session.models[0], summary: 'Final response', phase: 'final_answer', contentPreview: 'The second task is independently grouped and does not show the first task’s events.', content: 'The second task is independently grouped and does not show the first task’s events or hidden runtime bookkeeping.', contentAvailable: true },
    ],
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
  staleProjectsForAgent?: string;
}

export async function mockApiRoutes(
  page: import('@playwright/test').Page,
  overrides: FixtureOverrides = {},
) {
  const agentList = overrides.agents || ['claude', 'opencode', 'codex'];
  const cache = new Map<string, unknown>();

  function staleProjectsResponse(agent: string): ProjectsResponse {
    const response = JSON.parse(JSON.stringify(generateProjectsResponse(agent))) as ProjectsResponse;
    const today = todayStr();
    for (const entries of Object.values(response.projects)) {
      for (const entry of entries) {
        if (entry.date !== today) continue;
        entry.inputTokens = 0;
        entry.outputTokens = 0;
        entry.cacheReadTokens = 0;
        entry.totalTokens = 0;
        entry.totalCost = 0;
        entry.modelBreakdowns = entry.modelBreakdowns.map(model => ({
          ...model,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cost: 0,
        }));
      }
    }
    return response;
  }

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


      case 'settings':
        await route.fulfill({
          json: {
            codex: {
              officialDataPaths: ['/Users/test/.codex'],
              environmentDataPaths: [],
              customDataPaths: ['/Users/test/.custom-codex'],
              resolvedDataPaths: [
                { path: '/Users/test/.codex', kind: 'official', readable: true, sessionDirs: ['/Users/test/.codex/sessions', '/Users/test/.codex/archived_sessions'] },
                { path: '/Users/test/.custom-codex', kind: 'custom', readable: true, sessionDirs: ['/Users/test/.custom-codex/sessions', '/Users/test/.custom-codex/archived_sessions'] },
              ],
            },
          },
        });
        break;

      case 'settings/codex-data-paths':
        await route.fulfill({
          json: {
            codex: {
              officialDataPaths: ['/Users/test/.codex'],
              environmentDataPaths: [],
              customDataPaths: ['/Users/test/.custom-codex', '/Users/test/.another-codex'],
              resolvedDataPaths: [
                { path: '/Users/test/.codex', kind: 'official', readable: true, sessionDirs: ['/Users/test/.codex/sessions', '/Users/test/.codex/archived_sessions'] },
                { path: '/Users/test/.custom-codex', kind: 'custom', readable: true, sessionDirs: ['/Users/test/.custom-codex/sessions', '/Users/test/.custom-codex/archived_sessions'] },
                { path: '/Users/test/.another-codex', kind: 'custom', readable: false, sessionDirs: ['/Users/test/.another-codex/sessions', '/Users/test/.another-codex/archived_sessions'] },
              ],
            },
          },
        });
        break;

      case 'daily':
        await route.fulfill({
          json: getOrGenerate(`daily:${agent}`, () => generateDailyResponse(agent)),
        });
        break;

      case 'projects':
        await route.fulfill({
          json: overrides.staleProjectsForAgent === agent
            ? getOrGenerate(`projects:${agent}:stale`, () => staleProjectsResponse(agent))
            : getOrGenerate(`projects:${agent}`, () => generateProjectsResponse(agent)),
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

      case 'session-analytics':
        await route.fulfill({ json: getOrGenerate(`session-analytics:${agent}`, () => generateSessionAnalyticsResponse(agent)) });
        break;

      default:
        if (path.startsWith('sessions/')) {
          await route.fulfill({ json: generateSessionDetail(agent, decodeURIComponent(path.slice('sessions/'.length))) });
          break;
        }
        await route.continue();
        break;
    }
  });
}
