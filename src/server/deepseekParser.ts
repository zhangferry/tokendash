import './appSettings.js';
import { statSync } from 'node:fs';
import type { BlockGranularity } from './claudeJsonlParser.js';
import type { DailyEntry, DailyResponse, ProjectsResponse, BlocksResponse, ModelBreakdown } from '../shared/types.js';
import { modelCost, modelCostWithFallback } from '../shared/modelPricing.js';
import { buildUsageFileIndex } from './usageFileIndex.js';
import { readDeepseekSessionLog, scanDeepseekSessions, getDeepseekSessionsDir, type DeepseekSessionLog, type DeepseekEvent } from './deepseekSessionLog.js';

export { scanDeepseekSessions, isDeepseekAccessible } from './deepseekSessionLog.js';

interface TokenBuckets {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
}

export interface DeepseekTokenEvent extends TokenBuckets {
  seq: number;
  timestamp: string;
  provider: string;
  model: string;
  cost: number;
  costAvailable: boolean;
}

export interface DeepseekSession {
  id: string;
  cwd: string;
  createdAt: string;
  tokenEvents: DeepseekTokenEvent[];
}

type UnpricedTokenEvent = Omit<DeepseekTokenEvent, 'cost' | 'costAvailable'>;
type UnpricedSession = Omit<DeepseekSession, 'tokenEvents'> & { tokenEvents: UnpricedTokenEvent[] };
const DEFAULT_TZ = 'Asia/Shanghai';
const GRANULARITY_MINUTES: Record<BlockGranularity, number> = { hour: 60, '15m': 15, '5m': 5, '1m': 1 };

function object(value: unknown): Record<string, any> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : undefined;
}

function usageOf(event: DeepseekEvent): unknown {
  if (event.type === 'assistant/message' && event.data.usage !== undefined) return event.data.usage;
  const stream = event.data.stream;
  if (!Array.isArray(stream)) return undefined;
  for (let i = stream.length - 1; i >= 0; i--) {
    const chunk = object(stream[i])?.chunk;
    if (object(chunk)?.type === 'usage') return chunk.usage;
  }
  return undefined;
}

function usageBuckets(value: unknown, seq: number): TokenBuckets {
  const usage = object(value);
  if (!usage) throw new Error(`Invalid DeepSeek Harness token usage at event ${seq}`);
  const count = (key: string, optional = false): number => {
    const value = usage[key] ?? (optional ? 0 : undefined);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid DeepSeek Harness ${key} at event ${seq}`);
    return value;
  };
  const inputTokens = count('inputTokens');
  const outputTokens = count('outputTokens');
  const cacheReadTokens = count('cacheReadTokens', true);
  const cacheWriteTokens = count('cacheWriteTokens', true);
  const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  if (!Number.isSafeInteger(totalTokens) || (usage.totalTokens !== undefined && count('totalTokens') !== totalTokens)) {
    throw new Error(`Inconsistent DeepSeek Harness totalTokens at event ${seq}`);
  }
  // reasoningTokens is already part of outputTokens, never an extra bucket.
  if (usage.reasoningTokens !== undefined) count('reasoningTokens');
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens };
}

/** The provider-reported reducer mirrors Harness's usage-projection replacement slot. */
export function reduceDeepseekTokenEvents(log: DeepseekSessionLog): UnpricedTokenEvent[] {
  const result: UnpricedTokenEvent[] = [];
  let route: { provider: string; model: string } = { provider: 'unknown', model: 'unknown' };
  let last: { turn: number; step: number; index: number } | undefined;
  for (const [index, event] of log.events.entries()) {
    if (event.type === 'request/header') {
      const config = object(object(event.data.header)?.config);
      route = {
        provider: typeof config?.provider === 'string' && config.provider ? config.provider : 'unknown',
        model: typeof config?.model === 'string' && config.model ? config.model : 'unknown',
      };
    }
    if (index < log.inheritedEventCount) continue;
    const { turn, step } = event.data;
    if (event.type === 'llm/retry-started') {
      if (last && last.turn === turn && last.step === step) last = undefined;
      continue;
    }
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') continue;
    const usage = usageOf(event);
    if (usage === undefined) continue;
    if (!Number.isSafeInteger(turn) || turn < 0 || !Number.isSafeInteger(step) || step < 0) {
      throw new Error(`Invalid DeepSeek Harness settlement identity at event ${event.seq}`);
    }
    const source = object(object(event.data.message)?.source);
    const tokenEvent: UnpricedTokenEvent = {
      seq: event.seq,
      timestamp: new Date(event.time).toISOString(),
      provider: typeof source?.provider === 'string' && source.provider ? source.provider : route.provider,
      model: typeof source?.model === 'string' && source.model ? source.model : route.model,
      ...usageBuckets(usage, event.seq),
    };
    if (last && last.turn === turn && last.step === step) {
      // Replace the record itself so a correction cannot create negative chart points.
      result[last.index] = tokenEvent;
    } else {
      last = { turn, step, index: result.length };
      result.push(tokenEvent);
    }
  }
  return result;
}

export function deepseekModelCost(provider: string, model: string, buckets: TokenBuckets, timestamp: string): number {
  // deepseek-flash 等显示名别名在 shared/modelPricing.ts 的候选键里统一处理，与 provider 无关；
  // 未知模型按 FALLBACK_PRICING_MODEL 兜底计价，避免金额缺失。
  void provider;
  return modelCostWithFallback(model, buckets.inputTokens, buckets.outputTokens, buckets.cacheReadTokens, buckets.cacheWriteTokens, timestamp);
}

function unpricedSession(path: string): UnpricedSession {
  const log = readDeepseekSessionLog(path);
  return {
    id: log.header.id,
    cwd: normalizeDeepseekProjectPath(log.header.cwd ?? ''),
    createdAt: new Date(log.header.createdAt).toISOString(),
    tokenEvents: reduceDeepseekTokenEvents(log),
  };
}

function priceSession(session: UnpricedSession): DeepseekSession {
  return {
    ...session,
    tokenEvents: session.tokenEvents.map(event => {
      const cost = deepseekModelCost(event.provider, event.model, event, event.timestamp);
      // 兜底计价下 cost 恒有值；costAvailable 标记是否使用真实价目（未走兜底、且价目字段完整）。
      const exact = modelCost(event.model, event.inputTokens, event.outputTokens, event.cacheReadTokens, event.cacheWriteTokens, event.timestamp);
      return { ...event, cost, costAvailable: exact !== undefined };
    }),
  };
}

export function parseDeepseekSession(path: string): DeepseekSession | null {
  try { return priceSession(unpricedSession(path)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function parseAllDeepseekSessions(): DeepseekSession[] {
  const index = buildUsageFileIndex<UnpricedSession | null, { path: string }>({
    cacheName: 'deepseek-sessions', parserVersion: 'deepseek-v4-settlement-v1',
    files: scanDeepseekSessions().map(path => ({ path })),
    parseFile: file => {
      try { return unpricedSession(file.path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
  });
  // Persist only source facts; pricing is recomputed after every index lookup.
  return index.values.filter((session): session is UnpricedSession => session !== null).map(priceSession);
}

export function getDeepseekRevision(): string {
  return [getDeepseekSessionsDir(), ...scanDeepseekSessions().flatMap(path => {
    try {
      const stat = statSync(path);
      return [`${path}:${stat.mtimeMs}:${stat.size}:${stat.ino}`];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  })].join('|');
}

export function normalizeDeepseekProjectPath(cwd: string): string {
  return cwd.replace(/[\\/]+$/, '') || 'unknown';
}

interface Accumulator extends TokenBuckets {
  cost: number;
  costAvailable: boolean;
  entries: number;
}
interface Bucket { acc: Accumulator; models: Map<string, Accumulator> }
function emptyAcc(): Accumulator {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, cost: 0, costAvailable: true, entries: 0 };
}
function add(acc: Accumulator, event: DeepseekTokenEvent): void {
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens', 'cost'] as const) acc[key] += event[key];
  acc.costAvailable &&= event.costAvailable;
  acc.entries++;
}
function addBucket(bucket: Bucket, event: DeepseekTokenEvent): void {
  add(bucket.acc, event);
  let model = bucket.models.get(event.model);
  if (!model) { model = emptyAcc(); bucket.models.set(event.model, model); }
  add(model, event);
}
const formatters = new Map<string, Intl.DateTimeFormat>();
function dateTimeKey(timestamp: string, timezone: string): string {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    formatters.set(timezone, formatter);
  }
  const parts = formatter.formatToParts(new Date(timestamp));
  const part = (name: string) => parts.find(item => item.type === name)!.value;
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`;
}
function entry(date: string, bucket: Bucket): DailyEntry {
  const { acc } = bucket;
  const modelBreakdowns: ModelBreakdown[] = [...bucket.models].map(([modelName, value]) => ({
    modelName, totalTokens: value.totalTokens, inputTokens: value.inputTokens, outputTokens: value.outputTokens,
    cacheCreationTokens: value.cacheWriteTokens, cacheReadTokens: value.cacheReadTokens, cost: value.cost,
    costAvailable: value.costAvailable, estimatedTokens: 0,
  }));
  return {
    date, inputTokens: acc.inputTokens, outputTokens: acc.outputTokens, cacheCreationTokens: acc.cacheWriteTokens,
    cacheReadTokens: acc.cacheReadTokens, totalTokens: acc.totalTokens, totalCost: acc.cost, costAvailable: acc.costAvailable,
    modelsUsed: [...bucket.models.keys()], modelBreakdowns, estimatedTokens: 0,
  };
}
function group(sessions: DeepseekSession[], key: (session: DeepseekSession, event: DeepseekTokenEvent) => string): Map<string, Bucket> {
  const buckets = new Map<string, Bucket>();
  for (const session of sessions) for (const event of session.tokenEvents) {
    const name = key(session, event);
    let bucket = buckets.get(name);
    if (!bucket) { bucket = { acc: emptyAcc(), models: new Map() }; buckets.set(name, bucket); }
    addBucket(bucket, event);
  }
  return buckets;
}

export function buildDeepseekDailyFromSessions(sessions: DeepseekSession[], timezone = DEFAULT_TZ): DailyResponse {
  const grouped = group(sessions, (_session, event) => dateTimeKey(event.timestamp, timezone).slice(0, 10));
  const daily = [...grouped].sort(([a], [b]) => a.localeCompare(b)).map(([date, bucket]) => entry(date, bucket));
  const total = emptyAcc();
  for (const session of sessions) for (const event of session.tokenEvents) add(total, event);
  return {
    daily,
    totals: {
      inputTokens: total.inputTokens, outputTokens: total.outputTokens, cacheReadTokens: total.cacheReadTokens,
      cacheCreationTokens: total.cacheWriteTokens, totalTokens: total.totalTokens, totalCost: total.cost,
      costAvailable: total.costAvailable, estimatedTokens: 0,
    },
  };
}

export function getDailyResponse(options?: { timezone?: string }): DailyResponse {
  return buildDeepseekDailyFromSessions(parseAllDeepseekSessions(), options?.timezone);
}

export function getProjectsResponse(options?: { timezone?: string }): ProjectsResponse {
  const projects: Record<string, DailyEntry[]> = {};
  const sessions = parseAllDeepseekSessions();
  for (const project of new Set(sessions.map(session => session.cwd))) {
    projects[project] = buildDeepseekDailyFromSessions(sessions.filter(session => session.cwd === project), options?.timezone).daily;
  }
  return { projects };
}

export function getBlocksResponse(options?: { project?: string | null; timezone?: string; granularity?: BlockGranularity }): BlocksResponse {
  const timezone = options?.timezone ?? DEFAULT_TZ;
  const granularity = options?.granularity ?? 'hour';
  const minutes = GRANULARITY_MINUTES[granularity];
  const sessions = parseAllDeepseekSessions().filter(session => !options?.project || session.cwd === options.project);
  const grouped = group(sessions, (_session, event) => {
    const key = dateTimeKey(event.timestamp, timezone);
    return key.slice(0, 14) + String(Math.floor(Number(key.slice(14)) / minutes) * minutes).padStart(2, '0');
  });
  const windowStart = granularity === '1m' ? dateTimeKey(new Date(Date.now() - 15 * 60_000).toISOString(), timezone) : '';
  return {
    blocks: [...grouped].filter(([key]) => !windowStart || key >= windowStart).sort(([a], [b]) => a.localeCompare(b)).map(([key, { acc, models }]) => ({
      id: `deepseek-${granularity}-${key}`, startTime: key.replace(' ', 'T') + ':00',
      endTime: key.slice(0, 14).replace(' ', 'T') + String(Number(key.slice(14)) + minutes - 1).padStart(2, '0') + ':59',
      actualEndTime: null, isActive: false, isGap: false, entries: acc.entries,
      tokenCounts: { inputTokens: acc.inputTokens, outputTokens: acc.outputTokens, cacheCreationInputTokens: acc.cacheWriteTokens, cacheReadInputTokens: acc.cacheReadTokens },
      totalTokens: acc.totalTokens, costUSD: acc.cost, costAvailable: acc.costAvailable, models: [...models.keys()],
    })),
  };
}
