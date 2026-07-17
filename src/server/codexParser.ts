import { readFileSync, readdirSync, statSync, accessSync, constants } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import type { DailyEntry, DailyResponse, ProjectsResponse, BlockEntry, BlocksResponse, ModelBreakdown } from '../shared/types.js';
import { calculateCost, isLongContextCodexRequest } from './codexPricing.js';
import { buildUsageFileIndex } from './usageFileIndex.js';

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
  last_token_usage: TokenUsageSchema.optional(),
}).nullable().default(null);

const TokenCountPayloadSchema = z.object({
  type: z.literal('token_count'),
  info: TokenCountInfoSchema,
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedTokenEvent {
  timestamp: string;
  model?: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  longContextInputTokens: number;
  longContextCachedInputTokens: number;
  longContextOutputTokens: number;
}

export interface ParsedSession {
  id: string;
  cwd: string;
  model: string;
  createdAt: string;
  tokenEvents: ParsedTokenEvent[];
  forkedFromId?: string;
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
  longContextInputTokens: number;
  longContextCachedInputTokens: number;
  longContextOutputTokens: number;
}

interface AggregateBucket {
  acc: TokenAccumulator;
  models: Map<string, TokenAccumulator>;
}

const CODEX_INDEX_VERSION = 'codex-session-v3';
const CODEX_AGGREGATE_INDEX_VERSION = 'codex-aggregate-v3';
const DEFAULT_TZ = 'Asia/Shanghai';

/** Minimum number of token_count events sharing the same second-precision
 *  timestamp to indicate a fork replay batch. Codex Desktop forks replay the
 *  parent session's entire token_count history at the fork creation timestamp,
 *  producing dozens or hundreds of events all timestamped to the same second. */
const FORK_REPLAY_THRESHOLD = 5;

interface SerializedAggregateBucket {
  acc: TokenAccumulator;
  models: Record<string, TokenAccumulator>;
}

interface CodexFileAggregate {
  daily: Record<string, SerializedAggregateBucket>;
  projects: Record<string, Record<string, SerializedAggregateBucket>>;
  blocks: Record<string, SerializedAggregateBucket>;
  projectBlocks: Record<string, Record<string, SerializedAggregateBucket>>;
}

let responseBundleCache: {
  signature: string;
  responses: { daily: DailyResponse; projects: ProjectsResponse; blocks: BlocksResponse };
} | null = null;

function subtractTokenUsage(
  current: z.infer<typeof TokenUsageSchema>,
  previous: z.infer<typeof TokenUsageSchema> | null,
): ParsedTokenEvent {
  return {
    timestamp: '',
    inputTokens: Math.max(0, current.input_tokens - (previous?.input_tokens ?? 0)),
    cachedInputTokens: Math.max(0, current.cached_input_tokens - (previous?.cached_input_tokens ?? 0)),
    outputTokens: Math.max(0, current.output_tokens - (previous?.output_tokens ?? 0)),
    reasoningOutputTokens: Math.max(0, current.reasoning_output_tokens - (previous?.reasoning_output_tokens ?? 0)),
    totalTokens: Math.max(0, current.total_tokens - (previous?.total_tokens ?? 0)),
    longContextInputTokens: 0,
    longContextCachedInputTokens: 0,
    longContextOutputTokens: 0,
  };
}

function displayInputTokens(inputTokens: number, cachedInputTokens: number): number {
  return Math.max(0, inputTokens - cachedInputTokens);
}

function usageMagnitude(ev: ParsedTokenEvent): number {
  return ev.inputTokens + ev.cachedInputTokens + ev.outputTokens + ev.reasoningOutputTokens + ev.totalTokens;
}

function sameUsage(a: ParsedTokenEvent, b: ParsedTokenEvent): boolean {
  return a.inputTokens === b.inputTokens
    && a.cachedInputTokens === b.cachedInputTokens
    && a.outputTokens === b.outputTokens
    && a.reasoningOutputTokens === b.reasoningOutputTokens
    && a.totalTokens === b.totalTokens;
}

function chooseCodexUsageEvent(
  lastUsage: z.infer<typeof TokenUsageSchema> | undefined,
  totalUsage: z.infer<typeof TokenUsageSchema>,
  previousTotalUsage: z.infer<typeof TokenUsageSchema> | null,
): ParsedTokenEvent {
  const deltaFromTotal = subtractTokenUsage(totalUsage, previousTotalUsage);
  if (!lastUsage) return deltaFromTotal;

  const lastEvent = subtractTokenUsage(lastUsage, null);
  if (!previousTotalUsage || totalUsage.total_tokens <= previousTotalUsage.total_tokens || sameUsage(lastEvent, deltaFromTotal)) {
    return lastEvent;
  }

  // Codex's stable format reports last_token_usage as a per-request delta. If a
  // future format starts mirroring cumulative total_token_usage here, trusting it
  // would add cumulative snapshots repeatedly and inflate totals by multiples.
  // Only override last_token_usage when it exactly mirrors the cumulative total;
  // otherwise keep the stable Codex delta semantics.
  if (sameUsage(lastEvent, subtractTokenUsage(totalUsage, null)) && usageMagnitude(deltaFromTotal) > 0) {
    return deltaFromTotal;
  }

  return lastEvent;
}

function withLongContextUsage(ev: ParsedTokenEvent): ParsedTokenEvent {
  if (!isLongContextCodexRequest(ev.inputTokens)) return ev;
  return {
    ...ev,
    longContextInputTokens: ev.inputTokens,
    longContextCachedInputTokens: ev.cachedInputTokens,
    longContextOutputTokens: ev.outputTokens,
  };
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
  let currentModel = '';
  let createdAt = '';
  const tokenEvents: ParsedTokenEvent[] = [];
  let forkedFromId: string | undefined;
  let previousTotalUsage: z.infer<typeof TokenUsageSchema> | null = null;
  const seenTotalUsageSnapshots = new Set<string>();
  const seenUsageEvents = new Set<string>();

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
      if (payload.forked_from_id && !forkedFromId) {
        forkedFromId = payload.forked_from_id as string;
      }
    }

    if (type === 'turn_context') {
      const payload = (obj.payload as Record<string, unknown>) || {};
      if (payload.model) {
        currentModel = payload.model as string;
        if (!model) model = currentModel;
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
        const totalUsageKey = [
          info.total_token_usage.input_tokens,
          info.total_token_usage.cached_input_tokens,
          info.total_token_usage.output_tokens,
          info.total_token_usage.reasoning_output_tokens,
          info.total_token_usage.total_tokens,
        ].join(':');
        if (seenTotalUsageSnapshots.has(totalUsageKey)) continue;
        seenTotalUsageSnapshots.add(totalUsageKey);

        const rawEvent = chooseCodexUsageEvent(info.last_token_usage, info.total_token_usage, previousTotalUsage);
        previousTotalUsage = info.total_token_usage;

        if (rawEvent.inputTokens === 0 && rawEvent.cachedInputTokens === 0 && rawEvent.outputTokens === 0 && rawEvent.reasoningOutputTokens === 0) {
          continue;
        }

        const event = withLongContextUsage({
          ...rawEvent,
          timestamp,
          model: currentModel || model || undefined,
          cachedInputTokens: Math.min(rawEvent.cachedInputTokens, rawEvent.inputTokens),
        });
        const eventKey = [
          timestamp,
          model,
          event.inputTokens,
          event.cachedInputTokens,
          event.outputTokens,
          event.reasoningOutputTokens,
          event.totalTokens,
        ].join(':');
        if (seenUsageEvents.has(eventKey)) {
          continue;
        }
        seenUsageEvents.add(eventKey);
        tokenEvents.push(event);
      }
    }
  }

  if (!sessionId) return null;

  // Detect and remove fork replay events.
  //
  // When Codex Desktop forks a session, it replays the parent's entire
  // token_count history at the fork creation timestamp (all events get the
  // same second-precision timestamp). These replayed events have valid
  // per-request deltas and unique total_token_usage snapshots, so the per-file
  // dedup above does not catch them. Without filtering, the same tokens are
  // counted in both the parent file and the fork file, inflating totals ~2x.
  //
  // We detect replay batches by finding second-precision timestamps shared by
  // FORK_REPLAY_THRESHOLD or more token_count events. Normal Codex sessions
  // never produce more than a few token_count events per second.
  if (tokenEvents.length >= FORK_REPLAY_THRESHOLD) {
    const tsSecondCount = new Map<string, number>();
    for (const ev of tokenEvents) {
      const sec = ev.timestamp.slice(0, 19); // YYYY-MM-DDTHH:MM:SS
      tsSecondCount.set(sec, (tsSecondCount.get(sec) ?? 0) + 1);
    }
    const replaySeconds = new Set<string>();
    for (const [sec, count] of tsSecondCount) {
      if (count >= FORK_REPLAY_THRESHOLD) replaySeconds.add(sec);
    }
    if (replaySeconds.size > 0) {
      const filtered = tokenEvents.filter(
        ev => !replaySeconds.has(ev.timestamp.slice(0, 19)),
      );
      tokenEvents.length = 0;
      tokenEvents.push(...filtered);
    }
  }

  return { id: sessionId, cwd, model, createdAt, tokenEvents, forkedFromId };
}

/** Parse all Codex sessions. */
export function parseAllSessions(): ParsedSession[] {
  return loadIndexedSessions().sessions;
}

function loadIndexedSessions(): { sessions: ParsedSession[]; signature: string } {
  const result = buildUsageFileIndex<ParsedSession | null, { path: string }>({
    cacheName: 'codex-sessions',
    parserVersion: CODEX_INDEX_VERSION,
    files: scanCodexSessions().map(path => ({ path })),
    parseFile: file => parseCodexSession(file.path),
  });
  return {
    sessions: result.values.filter((session): session is ParsedSession => session !== null),
    signature: result.signature,
  };
}

function summarizeCodexSession(session: ParsedSession | null): CodexFileAggregate | null {
  if (!session) return null;
  const summary: CodexFileAggregate = { daily: {}, projects: {}, blocks: {}, projectBlocks: {} };
  const projectName = extractProjectName(session.cwd);

  for (const ev of session.tokenEvents) {
    const model = ev.model || session.model;
    const dayKey = getDateKey(ev.timestamp, DEFAULT_TZ);
    const hourKey = getHourKey(ev.timestamp, DEFAULT_TZ);

    addAccToSerializedBucket(bucketFor(summary.daily, dayKey), ev, model);
    addAccToSerializedBucket(bucketFor(summary.blocks, hourKey), ev, model);

    if (!summary.projects[projectName]) summary.projects[projectName] = {};
    addAccToSerializedBucket(bucketFor(summary.projects[projectName], dayKey), ev, model);

    if (!summary.projectBlocks[projectName]) summary.projectBlocks[projectName] = {};
    addAccToSerializedBucket(bucketFor(summary.projectBlocks[projectName], hourKey), ev, model);
  }

  return summary;
}

function loadIndexedAggregates(): { summaries: CodexFileAggregate[]; signature: string } {
  const result = buildUsageFileIndex<CodexFileAggregate | null, { path: string }>({
    cacheName: 'codex-aggregates',
    parserVersion: CODEX_AGGREGATE_INDEX_VERSION,
    files: scanCodexSessions().map(path => ({ path })),
    parseFile: file => summarizeCodexSession(parseCodexSession(file.path)),
  });
  const summaries = result.values.filter((summary): summary is CodexFileAggregate => summary !== null);

  // Safety net: cross-file dedup for fork replay events that may slip through
  // the per-file filter. When a session forks, Codex Desktop rewrites the
  // parent's token_count history at the fork timestamp. If both parent and fork
  // files are present, the same total_token_usage snapshots appear in both.
  // We detect this by checking if any two summaries have identical daily bucket
  // accumulator values for the same date, which indicates the same events were
  // counted twice.
  //
  // This is intentionally conservative: it only removes exact duplicate daily
  // buckets, not partial overlaps, to avoid over-filtering legitimate usage.
  // The primary fix is the fork replay timestamp-batch filter in parseCodexSession.
  return {
    summaries,
    signature: result.signature,
  };
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
  return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0, longContextInputTokens: 0, longContextCachedInputTokens: 0, longContextOutputTokens: 0 };
}

function addAcc(a: TokenAccumulator, ev: ParsedTokenEvent): void {
  a.inputTokens += ev.inputTokens;
  a.cachedInputTokens += ev.cachedInputTokens;
  a.outputTokens += ev.outputTokens;
  a.reasoningOutputTokens += ev.reasoningOutputTokens;
  a.totalTokens += ev.totalTokens;
  a.longContextInputTokens += ev.longContextInputTokens;
  a.longContextCachedInputTokens += ev.longContextCachedInputTokens;
  a.longContextOutputTokens += ev.longContextOutputTokens;
}

function displayAcc(acc: TokenAccumulator): TokenAccumulator {
  return {
    ...acc,
    inputTokens: displayInputTokens(acc.inputTokens, acc.cachedInputTokens),
  };
}

function mergeAcc(a: TokenAccumulator, b: TokenAccumulator): void {
  a.inputTokens += b.inputTokens;
  a.cachedInputTokens += b.cachedInputTokens;
  a.outputTokens += b.outputTokens;
  a.reasoningOutputTokens += b.reasoningOutputTokens;
  a.totalTokens += b.totalTokens;
  a.longContextInputTokens += b.longContextInputTokens ?? 0;
  a.longContextCachedInputTokens += b.longContextCachedInputTokens ?? 0;
  a.longContextOutputTokens += b.longContextOutputTokens ?? 0;
}

function addAccToBucket(bucket: AggregateBucket, ev: ParsedTokenEvent, model: string): void {
  addAcc(bucket.acc, ev);
  if (!model) return;
  if (!bucket.models.has(model)) bucket.models.set(model, emptyAcc());
  addAcc(bucket.models.get(model)!, ev);
}

function emptySerializedBucket(): SerializedAggregateBucket {
  return { acc: emptyAcc(), models: {} };
}

function bucketFor(map: Record<string, SerializedAggregateBucket>, key: string): SerializedAggregateBucket {
  if (!map[key]) map[key] = emptySerializedBucket();
  return map[key];
}

function addAccToSerializedBucket(bucket: SerializedAggregateBucket, ev: ParsedTokenEvent, model: string): void {
  addAcc(bucket.acc, ev);
  if (!model) return;
  if (!bucket.models[model]) bucket.models[model] = emptyAcc();
  addAcc(bucket.models[model], ev);
}

function mergeSerializedBucket(target: SerializedAggregateBucket, source: SerializedAggregateBucket): void {
  mergeAcc(target.acc, source.acc);
  for (const [model, modelAcc] of Object.entries(source.models)) {
    if (!target.models[model]) target.models[model] = emptyAcc();
    mergeAcc(target.models[model], modelAcc);
  }
}

function toAggregateBucket(bucket: SerializedAggregateBucket): AggregateBucket {
  return {
    acc: bucket.acc,
    models: new Map(Object.entries(bucket.models)),
  };
}

function accToEntry(date: string, acc: TokenAccumulator, modelAccs: Map<string, TokenAccumulator>): DailyEntry {
  const display = displayAcc(acc);
  const modelNames = [...modelAccs.keys()];
  const modelBreakdowns = buildModelBreakdowns(modelAccs);
  const totalCost = modelBreakdowns.reduce((sum, model) => sum + model.cost, 0);
  return {
    date,
    inputTokens: display.inputTokens,
    outputTokens: display.outputTokens,
    cacheCreationTokens: 0,
    cacheReadTokens: display.cachedInputTokens,
    totalTokens: display.totalTokens,
    totalCost,
    modelsUsed: modelNames,
    modelBreakdowns,
  };
}

function buildModelBreakdowns(modelAccs: Map<string, TokenAccumulator>): ModelBreakdown[] {
  return [...modelAccs.entries()].map(([modelName, acc]) => {
    const display = displayAcc(acc);
    return {
      modelName,
      inputTokens: display.inputTokens,
      outputTokens: display.outputTokens,
      cacheCreationTokens: 0,
      cacheReadTokens: display.cachedInputTokens,
      cost: calculateCost(acc, new Set([modelName])),
    };
  });
}

type GroupKey = string;

function groupSessions(
  sessions: ParsedSession[],
  options: AggregateOptions,
): Map<GroupKey, AggregateBucket> {
  const tz = options.timezone || 'Asia/Shanghai';
  const grouped = new Map<GroupKey, AggregateBucket>();

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
        grouped.set(key, { acc: emptyAcc(), models: new Map() });
      }
      addAccToBucket(grouped.get(key)!, ev, ev.model || session.model);
    }
  }

  return grouped;
}

// ---------------------------------------------------------------------------
// Public API — response builders for route handlers
// ---------------------------------------------------------------------------

export function buildCodexResponsesFromSessions(
  sessions: ParsedSession[],
  options?: Partial<AggregateOptions>,
): { daily: DailyResponse; projects: ProjectsResponse; blocks: BlocksResponse } {
  return {
    daily: buildDailyResponse(sessions, options),
    projects: buildProjectsResponse(sessions, options),
    blocks: buildBlocksResponse(sessions, options),
  };
}

function buildDailyResponseFromSummaries(summaries: CodexFileAggregate[]): DailyResponse {
  const dailyBuckets: Record<string, SerializedAggregateBucket> = {};
  const totalsAcc = emptyAcc();
  const totalModels = new Map<string, TokenAccumulator>();

  for (const summary of summaries) {
    for (const [date, bucket] of Object.entries(summary.daily)) {
      mergeSerializedBucket(bucketFor(dailyBuckets, date), bucket);
      mergeAcc(totalsAcc, bucket.acc);
      for (const [model, modelAcc] of Object.entries(bucket.models)) {
        if (!totalModels.has(model)) totalModels.set(model, emptyAcc());
        mergeAcc(totalModels.get(model)!, modelAcc);
      }
    }
  }

  const daily = Object.entries(dailyBuckets)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, bucket]) => {
      const { acc, models } = toAggregateBucket(bucket);
      return accToEntry(date, acc, models);
    });
  const totalCost = buildModelBreakdowns(totalModels).reduce((sum, model) => sum + model.cost, 0);

  return {
    daily,
    totals: {
      inputTokens: displayInputTokens(totalsAcc.inputTokens, totalsAcc.cachedInputTokens),
      outputTokens: totalsAcc.outputTokens,
      cacheCreationTokens: 0,
      cacheReadTokens: totalsAcc.cachedInputTokens,
      totalTokens: totalsAcc.totalTokens,
      totalCost,
    },
  };
}

function buildProjectsResponseFromSummaries(summaries: CodexFileAggregate[]): ProjectsResponse {
  const projectBuckets: Record<string, Record<string, SerializedAggregateBucket>> = {};

  for (const summary of summaries) {
    for (const [projectName, dailyBuckets] of Object.entries(summary.projects)) {
      if (!projectBuckets[projectName]) projectBuckets[projectName] = {};
      for (const [date, bucket] of Object.entries(dailyBuckets)) {
        mergeSerializedBucket(bucketFor(projectBuckets[projectName], date), bucket);
      }
    }
  }

  const projects: Record<string, DailyEntry[]> = {};
  for (const [projectName, dailyBuckets] of Object.entries(projectBuckets)) {
    projects[projectName] = Object.entries(dailyBuckets)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, bucket]) => {
        const { acc, models } = toAggregateBucket(bucket);
        return accToEntry(date, acc, models);
      });
  }

  return { projects };
}

function buildBlocksResponseFromSummaries(summaries: CodexFileAggregate[], project?: string | null): BlocksResponse {
  const blockBuckets: Record<string, SerializedAggregateBucket> = {};

  for (const summary of summaries) {
    const source = project ? summary.projectBlocks[project] || {} : summary.blocks;
    for (const [hourKey, bucket] of Object.entries(source)) {
      mergeSerializedBucket(bucketFor(blockBuckets, hourKey), bucket);
    }
  }

  const blocks: BlockEntry[] = Object.entries(blockBuckets)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([hourKey, bucket], idx) => {
      const { acc, models } = toAggregateBucket(bucket);
      const cost = buildModelBreakdowns(models).reduce((sum, model) => sum + model.cost, 0);
      const [datePart, timePart] = hourKey.split(' ');
      const hour = timePart.split(':')[0];
      return {
        id: `codex-hour-${idx}`,
        startTime: `${datePart}T${hour}:00:00`,
        endTime: `${datePart}T${hour}:59:59`,
        actualEndTime: null,
        isActive: false,
        isGap: false,
        entries: acc.totalTokens > 0 ? 1 : 0,
        tokenCounts: {
          inputTokens: displayInputTokens(acc.inputTokens, acc.cachedInputTokens),
          outputTokens: acc.outputTokens,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: acc.cachedInputTokens,
        },
        totalTokens: acc.totalTokens,
        costUSD: cost,
        models: [...models.keys()],
      };
    });

  return { blocks };
}

function usesDefaultBundleOptions(options?: Partial<AggregateOptions>): boolean {
  return !options || (
    !options.project
    && !options.since
    && !options.until
    && (!options.timezone || options.timezone === DEFAULT_TZ)
  );
}

export function getCodexResponses(options?: Partial<AggregateOptions>): {
  daily: DailyResponse;
  projects: ProjectsResponse;
  blocks: BlocksResponse;
} {
  const { summaries, signature } = loadIndexedAggregates();
  if (usesDefaultBundleOptions(options)) {
    if (responseBundleCache?.signature === signature) {
      return responseBundleCache.responses;
    }
    const responses = {
      daily: buildDailyResponseFromSummaries(summaries),
      projects: buildProjectsResponseFromSummaries(summaries),
      blocks: buildBlocksResponseFromSummaries(summaries),
    };
    responseBundleCache = { signature, responses };
    return responses;
  }
  const { sessions } = loadIndexedSessions();
  return buildCodexResponsesFromSessions(sessions, options);
}

function buildDailyResponse(sessions: ParsedSession[], options?: Partial<AggregateOptions>): DailyResponse {
  const grouped = groupSessions(sessions, { groupBy: 'day', ...options });

  const daily: DailyEntry[] = [];
  const totalsAcc = emptyAcc();

  const totalModels = new Map<string, TokenAccumulator>();
  for (const [date, { acc, models }] of grouped) {
    daily.push(accToEntry(date, acc, models));
    mergeAcc(totalsAcc, acc);
    for (const [model, modelAcc] of models) {
      if (!totalModels.has(model)) totalModels.set(model, emptyAcc());
      mergeAcc(totalModels.get(model)!, modelAcc);
    }
  }

  daily.sort((a, b) => a.date.localeCompare(b.date));

  const totalCost = buildModelBreakdowns(totalModels).reduce((sum, model) => sum + model.cost, 0);

  return {
    daily,
    totals: {
      inputTokens: displayInputTokens(totalsAcc.inputTokens, totalsAcc.cachedInputTokens),
      outputTokens: totalsAcc.outputTokens,
      cacheCreationTokens: 0,
      cacheReadTokens: totalsAcc.cachedInputTokens,
      totalTokens: totalsAcc.totalTokens,
      totalCost,
    },
  };
}

function buildProjectsResponse(sessions: ParsedSession[], options?: Partial<AggregateOptions>): ProjectsResponse {
  const tz = options?.timezone || 'Asia/Shanghai';
  const projectGroups = new Map<string, Map<string, AggregateBucket>>();

  for (const session of sessions) {
    const projectName = extractProjectName(session.cwd);
    if (options?.project && projectName !== options.project) continue;
    if (!projectGroups.has(projectName)) projectGroups.set(projectName, new Map());
    const dailyMap = projectGroups.get(projectName)!;

    for (const ev of session.tokenEvents) {
      const evDate = new Date(ev.timestamp);
      if (options?.since && evDate < options.since) continue;
      if (options?.until && evDate > options.until) continue;

      const dayKey = getDateKey(ev.timestamp, tz);
      if (!dailyMap.has(dayKey)) {
        dailyMap.set(dayKey, { acc: emptyAcc(), models: new Map() });
      }
      addAccToBucket(dailyMap.get(dayKey)!, ev, ev.model || session.model);
    }
  }

  const projects: Record<string, DailyEntry[]> = {};
  for (const [projectName, dailyMap] of projectGroups) {
    projects[projectName] = [...dailyMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, { acc, models }]) => accToEntry(date, acc, models));
  }

  return { projects };
}

function buildBlocksResponse(sessions: ParsedSession[], options?: Partial<AggregateOptions>): BlocksResponse {
  const grouped = groupSessions(sessions, { groupBy: 'hour', ...options });

  const blocks: BlockEntry[] = [];
  let idx = 0;

  for (const [hourKey, { acc, models }] of grouped) {
    const cost = buildModelBreakdowns(models).reduce((sum, model) => sum + model.cost, 0);
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
        inputTokens: displayInputTokens(acc.inputTokens, acc.cachedInputTokens),
        outputTokens: acc.outputTokens,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: acc.cachedInputTokens,
      },
      totalTokens: acc.totalTokens,
      costUSD: cost,
      models: [...models.keys()],
    });
    idx++;
  }

  blocks.sort((a, b) => a.startTime.localeCompare(b.startTime));

  return { blocks };
}

/** Aggregate and return DailyResponse format (for /daily?agent=codex) */
export function getDailyResponse(options?: Partial<AggregateOptions>): DailyResponse {
  return getCodexResponses(options).daily;
}

/** Aggregate and return ProjectsResponse format (for /projects?agent=codex) */
export function getProjectsResponse(options?: Partial<AggregateOptions>): ProjectsResponse {
  return getCodexResponses(options).projects;
}

/** Aggregate and return BlocksResponse format (hourly, for /blocks?agent=codex) */
export function getBlocksResponse(options?: Partial<AggregateOptions>): BlocksResponse {
  if (usesDefaultBundleOptions(options)) {
    return getCodexResponses(options).blocks;
  }
  if (!options?.since && !options?.until && (!options?.timezone || options.timezone === DEFAULT_TZ)) {
    return buildBlocksResponseFromSummaries(loadIndexedAggregates().summaries, options?.project);
  }
  return buildBlocksResponse(loadIndexedSessions().sessions, options);
}
