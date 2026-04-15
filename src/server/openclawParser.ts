import { readFileSync, readdirSync, statSync, accessSync, constants } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { DailyEntry, DailyResponse, ProjectsResponse, BlockEntry, BlocksResponse } from '../shared/types.js';

// ---------------------------------------------------------------------------
// OpenClaw JSONL format
//
// Each line in a session .jsonl file is one of:
//   { type: "model_change", provider: "anthropic", modelId: "claude-opus-4-6" }
//   { type: "custom", customType: "model-snapshot", data: { provider, modelId } }
//   { type: "message", message: { role, usage: { input, output, cacheRead, cacheWrite, cost: { total } }, timestamp (ms), model, provider } }
//
// sessions.json index:
//   { "<key>": { sessionId: "...", sessionFile?: "..." }, ... }
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OpenClawTokenEvent {
  timestampMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  cost: number;
  model: string;
}

interface OpenClawSession {
  id: string;
  agentId: string;
  tokenEvents: OpenClawTokenEvent[];
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
// Directory helpers
// ---------------------------------------------------------------------------

/** All directories OpenClaw may have used (current + legacy names). */
function getOpenClawDirs(): string[] {
  const home = homedir();
  return [
    join(home, '.openclaw'),
    join(home, '.clawdbot'),   // legacy name 1
    join(home, '.moltbot'),    // legacy name 2
    join(home, '.moldbot'),    // legacy name 3
  ];
}

export function isOpenClawAccessible(): boolean {
  for (const dir of getOpenClawDirs()) {
    try {
      accessSync(join(dir, 'agents'), constants.R_OK);
      return true;
    } catch {
      // try next
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Session scanning
// ---------------------------------------------------------------------------

interface SessionRef {
  sessionId: string;
  sessionFile: string; // absolute path to .jsonl
  agentId: string;
}

/** Scan all OpenClaw agent dirs and collect session file references. */
export function scanOpenClawSessions(): SessionRef[] {
  const refs: SessionRef[] = [];

  for (const baseDir of getOpenClawDirs()) {
    const agentsDir = join(baseDir, 'agents');
    let agentEntries: string[];
    try {
      agentEntries = readdirSync(agentsDir);
    } catch {
      continue;
    }

    for (const agentEntry of agentEntries) {
      const sessionsDir = join(agentsDir, agentEntry, 'sessions');
      const indexedPaths = new Set<string>();

      // Try sessions.json index first
      const indexPath = join(sessionsDir, 'sessions.json');
      try {
        const raw = readFileSync(indexPath, 'utf-8');
        const index = JSON.parse(raw) as Record<string, { sessionId?: string; sessionFile?: string }>;
        for (const entry of Object.values(index)) {
          if (!entry.sessionId) continue;
          let sessionPath: string;
          if (entry.sessionFile) {
            const filePath = entry.sessionFile;
            if (filePath.startsWith('/')) {
              // Validate absolute path stays within an OpenClaw directory
              if (!getOpenClawDirs().some(dir => filePath.startsWith(dir))) continue;
              sessionPath = filePath;
            } else {
              sessionPath = join(sessionsDir, filePath);
            }
          } else {
            sessionPath = join(sessionsDir, `${entry.sessionId}.jsonl`);
          }
          indexedPaths.add(sessionPath);
          refs.push({ sessionId: entry.sessionId, sessionFile: sessionPath, agentId: agentEntry });
        }
      } catch {
        // No sessions.json — will scan .jsonl files below
      }

      // Scan for .jsonl files not already covered by the index
      let files: string[];
      try {
        files = readdirSync(sessionsDir);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const fullPath = join(sessionsDir, f);
        if (indexedPaths.has(fullPath)) continue;
        const sessionId = f.replace(/\.jsonl.*$/, '');
        refs.push({ sessionId, sessionFile: fullPath, agentId: agentEntry });
      }
    }
  }

  return refs;
}

// ---------------------------------------------------------------------------
// Session-level cache (mtime-based invalidation)
// ---------------------------------------------------------------------------

const sessionCache = new Map<string, { mtime: number; result: OpenClawSession | null }>();

// ---------------------------------------------------------------------------
// JSONL parser
// ---------------------------------------------------------------------------

export function parseOpenClawSession(ref: SessionRef): OpenClawSession | null {
  let fileMtimeMs = 0;
  try {
    fileMtimeMs = statSync(ref.sessionFile).mtimeMs;
  } catch { /* ok */ }

  // Return cached result if file hasn't changed
  const cached = sessionCache.get(ref.sessionFile);
  if (cached && cached.mtime === fileMtimeMs) {
    return cached.result;
  }

  let content: string;
  try {
    content = readFileSync(ref.sessionFile, 'utf-8');
  } catch {
    return null;
  }

  const tokenEvents: OpenClawTokenEvent[] = [];
  let currentModel = '';
  let currentProvider = '';

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    const type = obj.type as string;

    if (type === 'model_change') {
      if (obj.modelId) currentModel = obj.modelId as string;
      if (obj.provider) currentProvider = obj.provider as string;
      continue;
    }

    if (type === 'custom' && (obj.customType as string) === 'model-snapshot') {
      const data = (obj.data as Record<string, unknown>) || {};
      if (data.modelId) currentModel = data.modelId as string;
      if (data.provider) currentProvider = data.provider as string;
      continue;
    }

    if (type === 'message') {
      const msg = (obj.message as Record<string, unknown>) || {};
      if ((msg.role as string) !== 'assistant') continue;

      const usage = (msg.usage as Record<string, unknown>) || {};
      if (!usage) continue;

      // Model: prefer embedded, fall back to tracked state
      const model = ((msg.model as string) || currentModel || '').trim();
      const provider = ((msg.provider as string) || currentProvider || '').trim();
      if (!model) continue; // can't attribute cost without a model

      // Update tracked state
      if (model) currentModel = model;
      if (provider) currentProvider = provider;

      const input = Number(usage.input ?? 0);
      const output = Number(usage.output ?? 0);
      const cacheRead = Number(usage.cacheRead ?? 0);
      const cacheWrite = Number(usage.cacheWrite ?? 0);
      const costObj = (usage.cost as Record<string, unknown>) || {};
      const cost = Number(costObj.total ?? 0);
      const timestampMs = Number(msg.timestamp ?? fileMtimeMs);

      tokenEvents.push({
        timestampMs,
        inputTokens: Math.max(0, input),
        outputTokens: Math.max(0, output),
        cacheReadTokens: Math.max(0, cacheRead),
        cacheWriteTokens: Math.max(0, cacheWrite),
        totalTokens: Math.max(0, input + output + cacheRead),
        cost: Math.max(0, cost),
        model: `${provider}/${model}`,
      });
    }
  }

  if (tokenEvents.length === 0) {
    sessionCache.set(ref.sessionFile, { mtime: fileMtimeMs, result: null });
    return null;
  }

  const result: OpenClawSession = { id: ref.sessionId, agentId: ref.agentId, tokenEvents };
  sessionCache.set(ref.sessionFile, { mtime: fileMtimeMs, result });
  return result;
}

export function parseAllOpenClawSessions(): OpenClawSession[] {
  return scanOpenClawSessions()
    .map(parseOpenClawSession)
    .filter((s): s is OpenClawSession => s !== null);
}

// ---------------------------------------------------------------------------
// Date / timezone helpers (same logic as codexParser)
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

function getMonthKey(ms: number, tz: string): string {
  return getDateKey(ms, tz).slice(0, 7);
}

// ---------------------------------------------------------------------------
// Aggregation helpers
// ---------------------------------------------------------------------------

function emptyAcc(): TokenAccumulator {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, cost: 0 };
}

function addEvent(acc: TokenAccumulator, ev: OpenClawTokenEvent): void {
  acc.inputTokens += ev.inputTokens;
  acc.outputTokens += ev.outputTokens;
  acc.cacheReadTokens += ev.cacheReadTokens;
  acc.cacheWriteTokens += ev.cacheWriteTokens;
  acc.totalTokens += ev.totalTokens;
  acc.cost += ev.cost;
}

function mergeAcc(a: TokenAccumulator, b: TokenAccumulator): void {
  a.inputTokens += b.inputTokens;
  a.outputTokens += b.outputTokens;
  a.cacheReadTokens += b.cacheReadTokens;
  a.cacheWriteTokens += b.cacheWriteTokens;
  a.totalTokens += b.totalTokens;
  a.cost += b.cost;
}

function accToEntry(date: string, acc: TokenAccumulator, models: Set<string>): DailyEntry {
  const modelList = [...models];
  const costPerModel = modelList.length > 0 ? acc.cost / modelList.length : 0;
  return {
    date,
    inputTokens: acc.inputTokens,
    outputTokens: acc.outputTokens,
    cacheCreationTokens: acc.cacheWriteTokens,
    cacheReadTokens: acc.cacheReadTokens,
    totalTokens: acc.totalTokens,
    totalCost: acc.cost,
    modelsUsed: modelList,
    modelBreakdowns: modelList.map(name => ({
      modelName: name,
      inputTokens: acc.inputTokens,
      outputTokens: acc.outputTokens,
      cacheCreationTokens: acc.cacheWriteTokens,
      cacheReadTokens: acc.cacheReadTokens,
      cost: costPerModel,
    })),
  };
}

// ---------------------------------------------------------------------------
// Public API — mirrors codexParser's response builders
// ---------------------------------------------------------------------------

export interface OpenClawAggregateOptions {
  groupBy?: 'day' | 'hour' | 'month' | 'session';
  since?: Date | null;
  until?: Date | null;
  timezone?: string;
  project?: string | null; // maps to agentId
}

export function getDailyResponse(options?: OpenClawAggregateOptions): DailyResponse {
  const sessions = parseAllOpenClawSessions();
  const tz = options?.timezone || 'Asia/Shanghai';

  const grouped = new Map<string, { acc: TokenAccumulator; models: Set<string> }>();
  const totalsAcc = emptyAcc();

  for (const session of sessions) {
    if (options?.project && session.agentId !== options.project) continue;

    for (const ev of session.tokenEvents) {
      if (options?.since && ev.timestampMs < options.since.getTime()) continue;
      if (options?.until && ev.timestampMs > options.until.getTime()) continue;

      const key = getDateKey(ev.timestampMs, tz);
      if (!grouped.has(key)) grouped.set(key, { acc: emptyAcc(), models: new Set() });
      const entry = grouped.get(key)!;
      addEvent(entry.acc, ev);
      entry.models.add(ev.model);
    }
  }

  const daily: DailyEntry[] = [];
  for (const [date, { acc, models }] of grouped) {
    daily.push(accToEntry(date, acc, models));
    mergeAcc(totalsAcc, acc);
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

export function getProjectsResponse(options?: OpenClawAggregateOptions): ProjectsResponse {
  const sessions = parseAllOpenClawSessions();
  const tz = options?.timezone || 'Asia/Shanghai';
  const projects: Record<string, DailyEntry[]> = {};

  for (const session of sessions) {
    const projectName = session.agentId;
    const dailyMap = new Map<string, { acc: TokenAccumulator; models: Set<string> }>();

    for (const ev of session.tokenEvents) {
      if (options?.since && ev.timestampMs < options.since.getTime()) continue;
      if (options?.until && ev.timestampMs > options.until.getTime()) continue;

      const dayKey = getDateKey(ev.timestampMs, tz);
      if (!dailyMap.has(dayKey)) dailyMap.set(dayKey, { acc: emptyAcc(), models: new Set() });
      addEvent(dailyMap.get(dayKey)!.acc, ev);
      dailyMap.get(dayKey)!.models.add(ev.model);
    }

    if (!projects[projectName]) projects[projectName] = [];
    for (const [date, { acc, models }] of dailyMap) {
      projects[projectName].push(accToEntry(date, acc, models));
    }
  }

  for (const key of Object.keys(projects)) {
    projects[key].sort((a, b) => a.date.localeCompare(b.date));
  }

  return { projects };
}

export function getBlocksResponse(options?: OpenClawAggregateOptions): BlocksResponse {
  const sessions = parseAllOpenClawSessions();
  const tz = options?.timezone || 'Asia/Shanghai';

  const grouped = new Map<string, { acc: TokenAccumulator; models: Set<string> }>();

  for (const session of sessions) {
    if (options?.project && session.agentId !== options.project) continue;

    for (const ev of session.tokenEvents) {
      if (options?.since && ev.timestampMs < options.since.getTime()) continue;
      if (options?.until && ev.timestampMs > options.until.getTime()) continue;

      const key = getHourKey(ev.timestampMs, tz);
      if (!grouped.has(key)) grouped.set(key, { acc: emptyAcc(), models: new Set() });
      addEvent(grouped.get(key)!.acc, ev);
      grouped.get(key)!.models.add(ev.model);
    }
  }

  const blocks: BlockEntry[] = [];
  let idx = 0;

  for (const [hourKey, { acc, models }] of grouped) {
    const [datePart, timePart] = hourKey.split(' ');
    const hour = timePart.split(':')[0];
    blocks.push({
      id: `openclaw-hour-${idx}`,
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
