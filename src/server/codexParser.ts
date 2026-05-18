import { readFileSync, readdirSync, statSync, accessSync, constants } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import type { DailyEntry, DailyResponse, ProjectsResponse, BlockEntry, BlocksResponse, Totals, ModelBreakdown } from '../shared/types.js';
import { calculateCost } from './codexPricing.js';

// ---------------------------------------------------------------------------
// Zod schemas for JSONL event validation (format change detector)
// ---------------------------------------------------------------------------

const TokenUsageSchema = z.object({
  input_tokens: z.number().default(0),
  cached_input_tokens: z.number().default(0),
  output_tokens: z.number().default(0),
  reasoning_output_tokens: z.number().default(0),
  total_tokens: z.number().default(0),
}).default({ input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 });

const TokenCountInfoSchema = z.object({
  total_token_usage: TokenUsageSchema,
  last_token_usage: TokenUsageSchema,
}).nullable().default(null);

const TokenCountPayloadSchema = z.object({
  type: z.literal('token_count'),
  info: TokenCountInfoSchema,
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ParsedTokenEvent {
  timestamp: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface ParsedSession {
  id: string;
  cwd: string;
  model: string;
  createdAt: string;
  tokenEvents: ParsedTokenEvent[];
}

export interface AggregateOptions {
  groupBy: 'day' | 'hour' | 'month' | 'session' | 'project';
  project?: string | null;
  since?: Date | null;
  until?: Date | null;
  timezone?: string;
}

interface TokenAccumulator {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

function tokenUsageKey(usage: z.infer<typeof TokenUsageSchema>): string {
  return [
    usage.input_tokens,
    usage.cached_input_tokens,
    usage.output_tokens,
    usage.reasoning_output_tokens,
    usage.total_tokens,
  ].join(':');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSessionsDir(): string {
  return join(homedir(), '.codex', 'sessions');
}

export function isSessionsDirAccessible(): boolean {
  try {
    accessSync(getSessionsDir(), constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Recursively find all .jsonl files under ~/.codex/sessions/
 */
export function scanCodexSessions(): string[] {
  const sessionsDir = getSessionsDir();
  const results: string[] = [];

  function walk(dir: string): void {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
      } else if (entry.endsWith('.jsonl')) {
        results.push(full);
      }
    }
  }

  walk(sessionsDir);
  return results.sort();
}

/**
 * Parse a single Codex session JSONL file.
 *
 * Codex can emit duplicate token_count events for the same turn, with identical
 * total_token_usage and last_token_usage snapshots a few seconds apart. These
 * are repeated status updates, not separate billable usage records, so only the
 * first occurrence of each cumulative total_token_usage snapshot should count.
 */
export function parseCodexSession(filepath: string): ParsedSession | null {
  let content: string;
  try {
    content = readFileSync(filepath, 'utf-8');
  } catch {
    return null;
  }

  const lines = content.split('\n');
  let sessionId = '';
  let cwd = '';
  let model = '';
  let createdAt = '';
  const tokenEvents: ParsedTokenEvent[] = [];
  const seenTotalUsageSnapshots = new Set<string>();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    const type = obj.type as string;

    if (type === 'session_meta') {
      const payload = (obj.payload as Record<string, unknown>) || {};
      sessionId = (payload.id as string) || '';
      cwd = (payload.cwd as string) || '';
      createdAt = (payload.timestamp as string) || '';
    }

    if (type === 'turn_context') {
      const payload = (obj.payload as Record<string, unknown>) || {};
      if (!model && payload.model) {
        model = payload.model as string;
      }
    }

    // Extract token counts from event_msg with nested token_count payload.
    if (type === 'event_msg') {
      const payload = (obj.payload as Record<string, unknown>) || {};
      if (payload.type === 'token_count') {
        const timestamp = (obj.timestamp as string) || '';
        const parseResult = TokenCountPayloadSchema.safeParse(payload);
        if (!parseResult.success) {
          console.warn(`[codexParser] Schema validation failed in ${filepath}:`, parseResult.error.message);
          continue;
        }
        const info = parseResult.data.info;
        if (!info) continue;
        const totalUsageKey = tokenUsageKey(info.total_token_usage);
        if (seenTotalUsageSnapshots.has(totalUsageKey)) continue;
        seenTotalUsageSnapshots.add(totalUsageKey);

        const last = info.last_token_usage;
        tokenEvents.push({
          timestamp,
          inputTokens: last.input_tokens,
          cachedInputTokens: last.cached_input_tokens,
          outputTokens: last.output_tokens,
          reasoningOutputTokens: last.reasoning_output_tokens,
          totalTokens: last.total_tokens,
        });
      }
    }
  }

  if (!sessionId) return null;

  return { id: sessionId, cwd, model, createdAt, tokenEvents };
}

/** Parse all Codex sessions. */
export function parseAllSessions(): ParsedSession[] {
  return scanCodexSessions()
    .map(parseCodexSession)
    .filter((s): s is ParsedSession => s !== null);
}

// ---------------------------------------------------------------------------
// Date/timezone helpers
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
  return TZ_OFFSETS[tz] ?? 8; // Default Asia/Shanghai
}

function toLocalISO(ts: string, tz: string): Date {
  const d = new Date(ts);
  return new Date(d.getTime() + getTzOffsetHours(tz) * 3600_000);
}

function getDateKey(ts: string, tz: string): string {
  return toLocalISO(ts, tz).toISOString().slice(0, 10);
}

function getHourKey(ts: string, tz: string): string {
  const local = toLocalISO(ts, tz);
  return local.toISOString().slice(0, 13).replace('T', ' ') + ':00';
}

function getMonthKey(ts: string, tz: string): string {
  return getDateKey(ts, tz).slice(0, 7);
}

function extractProjectName(cwd: string): string {
  if (!cwd) return 'unknown';
  const parts = cwd.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || 'unknown';
}

// ---------------------------------------------------------------------------
// Core aggregation
// ---------------------------------------------------------------------------

function emptyAcc(): TokenAccumulator {
  return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 };
}

function addAcc(a: TokenAccumulator, ev: ParsedTokenEvent): void {
  a.inputTokens += ev.inputTokens;
  a.cachedInputTokens += ev.cachedInputTokens;
  a.outputTokens += ev.outputTokens;
  a.reasoningOutputTokens += ev.reasoningOutputTokens;
  a.totalTokens += ev.totalTokens;
}

function mergeAcc(a: TokenAccumulator, b: TokenAccumulator): void {
  a.inputTokens += b.inputTokens;
  a.cachedInputTokens += b.cachedInputTokens;
  a.outputTokens += b.outputTokens;
  a.reasoningOutputTokens += b.reasoningOutputTokens;
  a.totalTokens += b.totalTokens;
}

function accToEntry(date: string, acc: TokenAccumulator, models: Set<string>): DailyEntry {
  const cost = calculateCost(acc, models);
  return {
    date,
    inputTokens: acc.inputTokens,
    outputTokens: acc.outputTokens,
    cacheCreationTokens: 0,
    cacheReadTokens: acc.cachedInputTokens,
    totalTokens: acc.totalTokens,
    totalCost: cost,
    modelsUsed: [...models],
    modelBreakdowns: buildModelBreakdowns(acc, models, cost),
  };
}

function buildModelBreakdowns(acc: TokenAccumulator, models: Set<string>, totalCost: number): ModelBreakdown[] {
  const modelList = [...models];
  if (modelList.length === 0) return [];
  const costPerModel = totalCost / modelList.length;
  return modelList.map(name => ({
    modelName: name,
    inputTokens: acc.inputTokens,
    outputTokens: acc.outputTokens,
    cacheCreationTokens: 0,
    cacheReadTokens: acc.cachedInputTokens,
    cost: costPerModel,
  }));
}

type GroupKey = string;

function groupSessions(
  sessions: ParsedSession[],
  options: AggregateOptions,
): Map<GroupKey, { acc: TokenAccumulator; models: Set<string> }> {
  const tz = options.timezone || 'Asia/Shanghai';
  const grouped = new Map<GroupKey, { acc: TokenAccumulator; models: Set<string> }>();

  for (const session of sessions) {
    if (options.project && extractProjectName(session.cwd) !== options.project) continue;

    for (const ev of session.tokenEvents) {
      const evDate = new Date(ev.timestamp);
      if (options.since && evDate < options.since) continue;
      if (options.until && evDate > options.until) continue;

      let key: string;
      switch (options.groupBy) {
        case 'hour':   key = getHourKey(ev.timestamp, tz); break;
        case 'month':  key = getMonthKey(ev.timestamp, tz); break;
        case 'session': key = session.id; break;
        case 'project': key = extractProjectName(session.cwd); break;
        default:       key = getDateKey(ev.timestamp, tz); break;
      }

      if (!grouped.has(key)) {
        grouped.set(key, { acc: emptyAcc(), models: new Set() });
      }
      const entry = grouped.get(key)!;
      addAcc(entry.acc, ev);
      if (session.model) entry.models.add(session.model);
    }
  }

  return grouped;
}

// ---------------------------------------------------------------------------
// Public API — response builders for route handlers
// ---------------------------------------------------------------------------

/** Aggregate and return DailyResponse format (for /daily?agent=codex) */
export function getDailyResponse(options?: Partial<AggregateOptions>): DailyResponse {
  const sessions = parseAllSessions();
  const grouped = groupSessions(sessions, { groupBy: 'day', ...options });

  const daily: DailyEntry[] = [];
  const totalsAcc = emptyAcc();

  for (const [date, { acc, models }] of grouped) {
    daily.push(accToEntry(date, acc, models));
    mergeAcc(totalsAcc, acc);
  }

  // Sort by date ascending
  daily.sort((a, b) => a.date.localeCompare(b.date));

  const models = new Set<string>();
  for (const s of sessions) if (s.model) models.add(s.model);
  const totalCost = calculateCost(totalsAcc, models);

  return {
    daily,
    totals: {
      inputTokens: totalsAcc.inputTokens,
      outputTokens: totalsAcc.outputTokens,
      cacheCreationTokens: 0,
      cacheReadTokens: totalsAcc.cachedInputTokens,
      totalTokens: totalsAcc.totalTokens,
      totalCost,
    },
  };
}

/** Aggregate and return ProjectsResponse format (for /projects?agent=codex) */
export function getProjectsResponse(options?: Partial<AggregateOptions>): ProjectsResponse {
  const sessions = parseAllSessions();
  const tz = options?.timezone || 'Asia/Shanghai';
  const projects: Record<string, DailyEntry[]> = {};

  for (const session of sessions) {
    const projectName = extractProjectName(session.cwd);

    // Per-project daily grouping
    const dailyMap = new Map<string, { acc: TokenAccumulator; models: Set<string> }>();
    for (const ev of session.tokenEvents) {
      const evDate = new Date(ev.timestamp);
      if (options?.since && evDate < options.since) continue;
      if (options?.until && evDate > options.until) continue;

      const dayKey = getDateKey(ev.timestamp, tz);
      if (!dailyMap.has(dayKey)) {
        dailyMap.set(dayKey, { acc: emptyAcc(), models: new Set() });
      }
      addAcc(dailyMap.get(dayKey)!.acc, ev);
      if (session.model) dailyMap.get(dayKey)!.models.add(session.model);
    }

    if (!projects[projectName]) projects[projectName] = [];
    for (const [date, { acc, models }] of dailyMap) {
      projects[projectName].push(accToEntry(date, acc, models));
    }
  }

  // Sort each project's daily entries
  for (const key of Object.keys(projects)) {
    projects[key].sort((a, b) => a.date.localeCompare(b.date));
  }

  return { projects };
}

/** Aggregate and return BlocksResponse format (hourly, for /blocks?agent=codex) */
export function getBlocksResponse(options?: Partial<AggregateOptions>): BlocksResponse {
  const sessions = parseAllSessions();
  const grouped = groupSessions(sessions, { groupBy: 'hour', ...options });

  const blocks: BlockEntry[] = [];
  let idx = 0;

  for (const [hourKey, { acc, models }] of grouped) {
    const cost = calculateCost(acc, models);
    const [datePart, timePart] = hourKey.split(' ');
    const hour = timePart.split(':')[0];

    blocks.push({
      id: `codex-hour-${idx}`,
      startTime: `${datePart}T${hour}:00:00`,
      endTime: `${datePart}T${hour}:59:59`,
      actualEndTime: null,
      isActive: false,
      isGap: false,
      entries: acc.totalTokens > 0 ? 1 : 0,
      tokenCounts: {
        inputTokens: acc.inputTokens,
        outputTokens: acc.outputTokens,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: acc.cachedInputTokens,
      },
      totalTokens: acc.totalTokens,
      costUSD: cost,
      models: [...models],
    });
    idx++;
  }

  // Sort by startTime
  blocks.sort((a, b) => a.startTime.localeCompare(b.startTime));

  return { blocks };
}
