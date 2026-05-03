import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { DailyEntry, DailyResponse, ProjectsResponse, BlockEntry, BlocksResponse } from '../shared/types.js';

// ---------------------------------------------------------------------------
// OpenCode SQLite format
//
// Database: ~/.local/share/opencode/opencode.db
// Table: message
// Column: data (JSON) with structure:
//   {
//     "role": "assistant",
//     "time": { "created": <ms>, "completed": <ms> },
//     "modelID": "glm-4.7",
//     "providerID": "zhipuai-coding-plan",
//     "tokens": { "input": N, "output": N, "reasoning": N, "cache": { "read": N, "write": N } },
//     "cost": N,
//     "path": { "cwd": "/path/to/project" }
//   }
// ---------------------------------------------------------------------------

const OPENCODE_DB = join(homedir(), '.local', 'share', 'opencode', 'opencode.db');

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export function isOpencodeAccessible(): boolean {
  return existsSync(OPENCODE_DB);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OpenCodeTokenEvent {
  timestampMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  cost: number;
  model: string;
  project: string;
}

interface TokenAccumulator {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  cost: number;
}

// ---------------------------------------------------------------------------
// SQLite query helper
// ---------------------------------------------------------------------------

function queryOpenCodeDB(sql: string): string {
  return execSync(`sqlite3 -json "${OPENCODE_DB}" "${sql}"`, {
    encoding: 'utf-8',
    maxBuffer: 50 * 1024 * 1024,
    timeout: 10000,
  });
}

// ---------------------------------------------------------------------------
// Parse all token events from message table
// ---------------------------------------------------------------------------

interface RawMessage {
  data: string;
}

export function parseAllOpenCodeEvents(project?: string | null): OpenCodeTokenEvent[] {
  let sql = `SELECT data FROM message WHERE json_extract(data, '$.role') = 'assistant'`;
  if (project) {
    sql += ` AND json_extract(data, '$.path.cwd') = '${project.replace(/'/g, "''")}'`;
  }

  let raw: string;
  try {
    raw = queryOpenCodeDB(sql);
  } catch {
    return [];
  }

  let rows: RawMessage[];
  try {
    rows = JSON.parse(raw) as RawMessage[];
  } catch {
    return [];
  }

  const events: OpenCodeTokenEvent[] = [];

  for (const row of rows) {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(row.data) as Record<string, unknown>;
    } catch {
      continue;
    }

    const tokens = (data.tokens as Record<string, unknown>) || {};
    const cache = (tokens.cache as Record<string, unknown>) || {};
    const time = (data.time as Record<string, unknown>) || {};
    const path = (data.path as Record<string, unknown>) || {};

    const input = Number(tokens.input ?? 0);
    const output = Number(tokens.output ?? 0);
    const cacheRead = Number(cache.read ?? 0);
    const cacheWrite = Number(cache.write ?? 0);

    if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) continue;

    events.push({
      timestampMs: Number(time.created ?? 0),
      inputTokens: Math.max(0, input),
      outputTokens: Math.max(0, output),
      cacheReadTokens: Math.max(0, cacheRead),
      cacheWriteTokens: Math.max(0, cacheWrite),
      totalTokens: Math.max(0, input + output + cacheRead),
      cost: Math.max(0, Number(data.cost ?? 0)),
      model: String(data.modelID ?? 'unknown'),
      project: String(path.cwd ?? ''),
    });
  }

  return events;
}

// ---------------------------------------------------------------------------
// Date / timezone helpers (same logic as openclawParser)
// ---------------------------------------------------------------------------

const TZ_OFFSETS: Record<string, number> = {
  'Asia/Shanghai': 8,
  'Asia/Tokyo': 9,
  'America/New_York': -5,
  'America/Los_Angeles': -8,
  'Europe/London': 0,
  'UTC': 0,
};

function getTzOffsetHours(tz: string): number {
  return TZ_OFFSETS[tz] ?? 8;
}

function msToLocalDate(ms: number, tz: string): Date {
  return new Date(ms + getTzOffsetHours(tz) * 3_600_000);
}

function getDateKey(ms: number, tz: string): string {
  return msToLocalDate(ms, tz).toISOString().slice(0, 10);
}

function getHourKey(ms: number, tz: string): string {
  const d = msToLocalDate(ms, tz);
  return d.toISOString().slice(0, 13).replace('T', ' ') + ':00';
}

// ---------------------------------------------------------------------------
// Aggregation helpers
// ---------------------------------------------------------------------------

function emptyAcc(): TokenAccumulator {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, cost: 0 };
}

function addEvent(acc: TokenAccumulator, ev: OpenCodeTokenEvent): void {
  acc.inputTokens += ev.inputTokens;
  acc.outputTokens += ev.outputTokens;
  acc.cacheReadTokens += ev.cacheReadTokens;
  acc.cacheWriteTokens += ev.cacheWriteTokens;
  acc.totalTokens += ev.totalTokens;
  acc.cost += ev.cost;
}

// ---------------------------------------------------------------------------
// Public API — mirrors openclawParser's response builders
// ---------------------------------------------------------------------------

export interface OpenCodeAggregateOptions {
  project?: string | null;
  timezone?: string;
}

export function getDailyResponse(options?: OpenCodeAggregateOptions): DailyResponse {
  const events = parseAllOpenCodeEvents(options?.project);
  const tz = options?.timezone || 'Asia/Shanghai';

  // Track per-day, per-model accumulators for correct breakdowns
  interface ModelAcc { inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number; cost: number; }
  interface DayGroup { totals: TokenAccumulator; models: Map<string, ModelAcc>; }
  const grouped = new Map<string, DayGroup>();

  for (const ev of events) {
    const key = getDateKey(ev.timestampMs, tz);
    if (!grouped.has(key)) grouped.set(key, { totals: emptyAcc(), models: new Map() });
    const g = grouped.get(key)!;
    addEvent(g.totals, ev);

    if (!g.models.has(ev.model)) {
      g.models.set(ev.model, { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0 });
    }
    const m = g.models.get(ev.model)!;
    m.inputTokens += ev.inputTokens;
    m.outputTokens += ev.outputTokens;
    m.cacheCreationTokens += ev.cacheWriteTokens;
    m.cacheReadTokens += ev.cacheReadTokens;
    m.cost += ev.cost;
  }

  const totalsAcc = emptyAcc();
  const daily: DailyEntry[] = [];
  for (const [date, g] of grouped) {
    mergeAcc(totalsAcc, g.totals);
    const modelList = [...g.models.keys()];
    daily.push({
      date,
      inputTokens: g.totals.inputTokens,
      outputTokens: g.totals.outputTokens,
      cacheCreationTokens: g.totals.cacheWriteTokens,
      cacheReadTokens: g.totals.cacheReadTokens,
      totalTokens: g.totals.totalTokens,
      totalCost: g.totals.cost,
      modelsUsed: modelList,
      modelBreakdowns: modelList.map(name => {
        const m = g.models.get(name)!;
        return {
          modelName: name,
          inputTokens: m.inputTokens,
          outputTokens: m.outputTokens,
          cacheCreationTokens: m.cacheCreationTokens,
          cacheReadTokens: m.cacheReadTokens,
          cost: m.cost,
        };
      }),
    });
  }
  daily.sort((a, b) => a.date.localeCompare(b.date));

  return {
    daily,
    totals: {
      inputTokens: totalsAcc.inputTokens,
      outputTokens: totalsAcc.outputTokens,
      cacheCreationTokens: totalsAcc.cacheWriteTokens,
      cacheReadTokens: totalsAcc.cacheReadTokens,
      totalTokens: totalsAcc.totalTokens,
      totalCost: totalsAcc.cost,
    },
  };
}

function mergeAcc(a: TokenAccumulator, b: TokenAccumulator): void {
  a.inputTokens += b.inputTokens;
  a.outputTokens += b.outputTokens;
  a.cacheReadTokens += b.cacheReadTokens;
  a.cacheWriteTokens += b.cacheWriteTokens;
  a.totalTokens += b.totalTokens;
  a.cost += b.cost;
}

export function getProjectsResponse(options?: OpenCodeAggregateOptions): ProjectsResponse {
  const events = parseAllOpenCodeEvents();
  const tz = options?.timezone || 'Asia/Shanghai';
  const projects: Record<string, DailyEntry[]> = {};

  for (const ev of events) {
    const projectName = ev.project || 'unknown';
    const dayKey = getDateKey(ev.timestampMs, tz);

    if (!projects[projectName]) projects[projectName] = [];

    // Find or create entry for this date in this project
    let dayEntry = projects[projectName].find(d => d.date === dayKey);
    if (!dayEntry) {
      dayEntry = {
        date: dayKey,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 0,
        totalCost: 0,
        modelsUsed: [],
        modelBreakdowns: [],
      };
      projects[projectName].push(dayEntry);
    }

    dayEntry.inputTokens += ev.inputTokens;
    dayEntry.outputTokens += ev.outputTokens;
    dayEntry.cacheCreationTokens += ev.cacheWriteTokens;
    dayEntry.cacheReadTokens += ev.cacheReadTokens;
    dayEntry.totalTokens += ev.totalTokens;
    dayEntry.totalCost += ev.cost;

    if (!dayEntry.modelsUsed.includes(ev.model)) {
      dayEntry.modelsUsed.push(ev.model);
    }

    // Update or add model breakdown
    let breakdown = dayEntry.modelBreakdowns.find(b => b.modelName === ev.model);
    if (!breakdown) {
      breakdown = {
        modelName: ev.model,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        cost: 0,
      };
      dayEntry.modelBreakdowns.push(breakdown);
    }
    breakdown.inputTokens += ev.inputTokens;
    breakdown.outputTokens += ev.outputTokens;
    breakdown.cacheCreationTokens += ev.cacheWriteTokens;
    breakdown.cacheReadTokens += ev.cacheReadTokens;
    breakdown.cost += ev.cost;
  }

  for (const key of Object.keys(projects)) {
    projects[key].sort((a, b) => a.date.localeCompare(b.date));
  }

  return { projects };
}

export function getBlocksResponse(options?: OpenCodeAggregateOptions): BlocksResponse {
  const events = parseAllOpenCodeEvents(options?.project);
  const tz = options?.timezone || 'Asia/Shanghai';

  const grouped = new Map<string, { acc: TokenAccumulator; models: Set<string> }>();

  for (const ev of events) {
    const key = getHourKey(ev.timestampMs, tz);
    if (!grouped.has(key)) grouped.set(key, { acc: emptyAcc(), models: new Set() });
    addEvent(grouped.get(key)!.acc, ev);
    grouped.get(key)!.models.add(ev.model);
  }

  const blocks: BlockEntry[] = [];
  let idx = 0;

  for (const [hourKey, { acc, models }] of grouped) {
    const [datePart, timePart] = hourKey.split(' ');
    const hour = timePart.split(':')[0];
    blocks.push({
      id: `opencode-hour-${idx}`,
      startTime: `${datePart}T${hour}:00:00`,
      endTime: `${datePart}T${hour}:59:59`,
      actualEndTime: null,
      isActive: false,
      isGap: false,
      entries: acc.totalTokens > 0 ? 1 : 0,
      tokenCounts: {
        inputTokens: acc.inputTokens,
        outputTokens: acc.outputTokens,
        cacheCreationInputTokens: acc.cacheWriteTokens,
        cacheReadInputTokens: acc.cacheReadTokens,
      },
      totalTokens: acc.totalTokens,
      costUSD: acc.cost,
      models: [...models],
    });
    idx++;
  }

  blocks.sort((a, b) => a.startTime.localeCompare(b.startTime));
  return { blocks };
}
