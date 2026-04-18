import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { DailyEntry, DailyResponse, ProjectsResponse, Totals, BlockEntry } from '../shared/types.js';

// ---------------------------------------------------------------------------
// Model pricing (USD per 1M tokens)
// Update from https://docs.anthropic.com/en/docs/about-claude/models when needed
// ---------------------------------------------------------------------------

interface ModelPricing {
  inputPer1M: number;
  cacheReadPer1M: number;
  outputPer1M: number;
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  // Claude 4.6
  'claude-opus-4-6': { inputPer1M: 15, cacheReadPer1M: 1.50, outputPer1M: 75 },
  'claude-sonnet-4-6': { inputPer1M: 3, cacheReadPer1M: 0.30, outputPer1M: 15 },
  // Claude 4.5
  'claude-sonnet-4-5-20250514': { inputPer1M: 3, cacheReadPer1M: 0.30, outputPer1M: 15 },
  'claude-haiku-4-5-20251001': { inputPer1M: 0.80, cacheReadPer1M: 0.08, outputPer1M: 4 },
  // Older Claude models
  'claude-3-5-sonnet-20241022': { inputPer1M: 3, cacheReadPer1M: 0.30, outputPer1M: 15 },
  'claude-3-5-haiku-20241022': { inputPer1M: 0.80, cacheReadPer1M: 0.08, outputPer1M: 4 },
  'claude-3-opus-20240229': { inputPer1M: 15, cacheReadPer1M: 1.50, outputPer1M: 75 },
  'claude-3-haiku-20240307': { inputPer1M: 0.25, cacheReadPer1M: 0.03, outputPer1M: 1.25 },
};

const DEFAULT_PRICING: ModelPricing = { inputPer1M: 3, cacheReadPer1M: 0.30, outputPer1M: 15 };

function getPricing(model: string): ModelPricing {
  // Try exact match first, then prefix match
  if (MODEL_PRICING[model]) return MODEL_PRICING[model];
  const lower = model.toLowerCase();
  for (const key of Object.keys(MODEL_PRICING)) {
    if (lower.startsWith(key) || lower.includes(key)) return MODEL_PRICING[key];
  }
  return DEFAULT_PRICING;
}

export function calculateCost(inputTokens: number, cacheReadTokens: number, outputTokens: number, model: string): number {
  const p = getPricing(model);
  const nonCachedInput = Math.max(inputTokens - cacheReadTokens, 0);
  return (nonCachedInput / 1_000_000) * p.inputPer1M
    + (cacheReadTokens / 1_000_000) * p.cacheReadPer1M
    + (outputTokens / 1_000_000) * p.outputPer1M;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ParsedUsage {
  timestamp: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  projectDir: string;
}

// ---------------------------------------------------------------------------
// JSONL parsing with mtime cache
// ---------------------------------------------------------------------------

const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');

const fileCache = new Map<string, { mtime: number; entries: ParsedUsage[] }>();

function extractProjectName(dirName: string): string {
  const parts = dirName.replace(/^-/, '').split('-');
  return parts[parts.length - 1] || dirName;
}

function matchesProject(dirName: string, filter: string): boolean {
  return extractProjectName(dirName) === extractProjectName(filter);
}

function findJsonlFiles(dir: string): string[] {
  const results: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        results.push(...findJsonlFiles(join(dir, entry.name)));
      } else if (entry.name.endsWith('.jsonl')) {
        results.push(join(dir, entry.name));
      }
    }
  } catch { /* skip unreadable dirs */ }
  return results;
}

function parseAllSessions(project?: string | null): ParsedUsage[] {
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return [];

  const results: ParsedUsage[] = [];
  const projectDirs = readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  for (const dirName of projectDirs) {
    if (project && !matchesProject(dirName, project)) continue;

    const dirPath = join(CLAUDE_PROJECTS_DIR, dirName);
    const files = findJsonlFiles(dirPath);

    for (const filePath of files) {

      let mtime = 0;
      try { mtime = statSync(filePath).mtimeMs; } catch { /* ok */ }

      const cached = fileCache.get(filePath);
      if (cached && cached.mtime === mtime) {
        results.push(...cached.entries);
        continue;
      }

      const entries: ParsedUsage[] = [];
      let content: string;
      try {
        content = readFileSync(filePath, 'utf-8');
      } catch {
        continue;
      }

      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let obj: Record<string, unknown>;
        try { obj = JSON.parse(trimmed) as Record<string, unknown>; } catch { continue; }

        if (obj.type !== 'assistant' || !obj.message) continue;
        const msg = obj.message as Record<string, unknown>;
        const usage = (msg.usage as Record<string, number>) || {};

        const inputTokens = usage.input_tokens || 0;
        const outputTokens = usage.output_tokens || 0;
        const cacheCreationTokens = usage.cache_creation_input_tokens || 0;
        const cacheReadTokens = usage.cache_read_input_tokens || 0;
        const totalTokens = inputTokens + outputTokens + cacheReadTokens;

        if (totalTokens === 0) continue;

        entries.push({
          timestamp: obj.timestamp as string,
          model: (msg.model as string) || 'unknown',
          inputTokens,
          outputTokens,
          cacheCreationTokens,
          cacheReadTokens,
          projectDir: dirName,
        });
      }

      fileCache.set(filePath, { mtime, entries });
      results.push(...entries);
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Timezone helpers
// ---------------------------------------------------------------------------

const TZ_OFFSETS: Record<string, number> = {
  'Asia/Shanghai': 8,
  'Asia/Tokyo': 9,
  'America/New_York': -5,
  'America/Los_Angeles': -8,
  'Europe/London': 0,
  'UTC': 0,
};

export function getDateKey(timestamp: string, tz: string): string {
  const offset = (TZ_OFFSETS[tz] ?? 8) * 3_600_000;
  const d = new Date(new Date(timestamp).getTime() + offset);
  // Use UTC methods since we manually applied the timezone offset
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export function getHourKey(timestamp: string, tz: string): string {
  const offset = (TZ_OFFSETS[tz] ?? 8) * 3_600_000;
  const d = new Date(new Date(timestamp).getTime() + offset);
  // Use UTC methods since we manually applied the timezone offset
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${hh}`;
}

// ---------------------------------------------------------------------------
// Aggregation helpers
// ---------------------------------------------------------------------------

interface DayAgg {
  date: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  totalCost: number;
  models: Map<string, { input: number; output: number; cacheCreation: number; cacheRead: number; cost: number }>;
}

function toDailyEntry(agg: DayAgg): DailyEntry {
  const modelBreakdowns = [...agg.models.entries()].map(([modelName, m]) => ({
    modelName,
    inputTokens: m.input,
    outputTokens: m.output,
    cacheCreationTokens: m.cacheCreation,
    cacheReadTokens: m.cacheRead,
    cost: m.cost,
  }));

  return {
    date: agg.date,
    inputTokens: agg.inputTokens,
    outputTokens: agg.outputTokens,
    cacheCreationTokens: agg.cacheCreationTokens,
    cacheReadTokens: agg.cacheReadTokens,
    totalTokens: agg.totalTokens,
    totalCost: Math.round(agg.totalCost * 10000) / 10000,
    modelsUsed: [...agg.models.keys()],
    modelBreakdowns,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const DEFAULT_TZ = 'Asia/Shanghai';

export function getDailyResponse(project?: string | null, tz = DEFAULT_TZ): DailyResponse {
  const entries = parseAllSessions(project);
  const dayMap = new Map<string, DayAgg>();

  for (const e of entries) {
    const date = getDateKey(e.timestamp, tz);
    if (!dayMap.has(date)) {
      dayMap.set(date, {
        date, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0,
        cacheReadTokens: 0, totalTokens: 0, totalCost: 0,
        models: new Map(),
      });
    }
    const agg = dayMap.get(date)!;
    agg.inputTokens += e.inputTokens;
    agg.outputTokens += e.outputTokens;
    agg.cacheCreationTokens += e.cacheCreationTokens;
    agg.cacheReadTokens += e.cacheReadTokens;
    agg.totalTokens += e.inputTokens + e.outputTokens + e.cacheReadTokens;

    const cost = calculateCost(e.inputTokens, e.cacheReadTokens, e.outputTokens, e.model);
    agg.totalCost += cost;

    if (!agg.models.has(e.model)) {
      agg.models.set(e.model, { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, cost: 0 });
    }
    const m = agg.models.get(e.model)!;
    m.input += e.inputTokens;
    m.output += e.outputTokens;
    m.cacheCreation += e.cacheCreationTokens;
    m.cacheRead += e.cacheReadTokens;
    m.cost += cost;
  }

  const daily = [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date)).map(toDailyEntry);
  const totals: Totals = daily.reduce((acc, d) => ({
    inputTokens: acc.inputTokens + d.inputTokens,
    outputTokens: acc.outputTokens + d.outputTokens,
    cacheCreationTokens: acc.cacheCreationTokens + d.cacheCreationTokens,
    cacheReadTokens: acc.cacheReadTokens + d.cacheReadTokens,
    totalTokens: acc.totalTokens + d.totalTokens,
    totalCost: acc.totalCost + d.totalCost,
  }), { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0, totalCost: 0 });

  return { daily, totals };
}

export function getProjectsResponse(tz = DEFAULT_TZ): ProjectsResponse {
  const entries = parseAllSessions();
  const projectMap = new Map<string, Map<string, DayAgg>>();

  for (const e of entries) {
    const date = getDateKey(e.timestamp, tz);
    const projectName = e.projectDir;

    if (!projectMap.has(projectName)) {
      projectMap.set(projectName, new Map());
    }
    const dayMap = projectMap.get(projectName)!;

    if (!dayMap.has(date)) {
      dayMap.set(date, {
        date, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0,
        cacheReadTokens: 0, totalTokens: 0, totalCost: 0,
        models: new Map(),
      });
    }
    const agg = dayMap.get(date)!;
    agg.inputTokens += e.inputTokens;
    agg.outputTokens += e.outputTokens;
    agg.cacheCreationTokens += e.cacheCreationTokens;
    agg.cacheReadTokens += e.cacheReadTokens;
    agg.totalTokens += e.inputTokens + e.outputTokens + e.cacheReadTokens;

    const cost = calculateCost(e.inputTokens, e.cacheReadTokens, e.outputTokens, e.model);
    agg.totalCost += cost;

    if (!agg.models.has(e.model)) {
      agg.models.set(e.model, { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, cost: 0 });
    }
    const m = agg.models.get(e.model)!;
    m.input += e.inputTokens;
    m.output += e.outputTokens;
    m.cacheCreation += e.cacheCreationTokens;
    m.cacheRead += e.cacheReadTokens;
    m.cost += cost;
  }

  const projects: Record<string, DailyEntry[]> = {};
  for (const [projectName, dayMap] of projectMap) {
    projects[projectName] = [...dayMap.values()]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map(toDailyEntry);
  }

  return { projects };
}

export function getBlocksResponse(project?: string | null, tz = DEFAULT_TZ): { blocks: BlockEntry[] } {
  const entries = parseAllSessions(project);
  const hourMap = new Map<string, {
    inputTokens: number; outputTokens: number; cacheCreationTokens: number;
    cacheReadTokens: number; costUSD: number; models: Set<string>;
  }>();

  for (const e of entries) {
    const hourKey = getHourKey(e.timestamp, tz);
    if (!hourMap.has(hourKey)) {
      hourMap.set(hourKey, {
        inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0,
        cacheReadTokens: 0, costUSD: 0, models: new Set(),
      });
    }
    const bucket = hourMap.get(hourKey)!;
    bucket.inputTokens += e.inputTokens;
    bucket.outputTokens += e.outputTokens;
    bucket.cacheCreationTokens += e.cacheCreationTokens;
    bucket.cacheReadTokens += e.cacheReadTokens;
    bucket.costUSD += calculateCost(e.inputTokens, e.cacheReadTokens, e.outputTokens, e.model);
    bucket.models.add(e.model);
  }

  const blocks: BlockEntry[] = [];
  let idx = 0;
  for (const [hourKey, bucket] of hourMap) {
    const totalTokens = bucket.inputTokens + bucket.outputTokens + bucket.cacheReadTokens;
    blocks.push({
      id: `claude-${idx}`,
      startTime: `${hourKey}:00:00`,
      endTime: `${hourKey}:59:59`,
      actualEndTime: null,
      isActive: false,
      isGap: false,
      entries: totalTokens > 0 ? 1 : 0,
      tokenCounts: {
        inputTokens: bucket.inputTokens,
        outputTokens: bucket.outputTokens,
        cacheCreationInputTokens: bucket.cacheCreationTokens,
        cacheReadInputTokens: bucket.cacheReadTokens,
      },
      totalTokens,
      costUSD: Math.round(bucket.costUSD * 10000) / 10000,
      models: [...bucket.models],
    });
    idx++;
  }

  blocks.sort((a, b) => a.startTime.localeCompare(b.startTime));
  return { blocks };
}
