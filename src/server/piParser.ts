import { readFileSync, readdirSync, statSync, accessSync, constants } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { DailyEntry, DailyResponse, ProjectsResponse, BlockEntry, BlocksResponse, ModelBreakdown } from '../shared/types.js';
import { buildUsageFileIndex } from './usageFileIndex.js';

// ---------------------------------------------------------------------------
// Pi JSONL 格式说明
//
// 会话文件位于 ~/.pi/agent/sessions/<project-dir-slug>/<timestamp>_<id>.jsonl
// 每行 type 之一：
//   session        — {"type":"session","id":"...","timestamp":"...","cwd":"D:\\file\\Zed"}
//   model_change   — {"type":"model_change","provider":"amax","modelId":"qwen3.8-max-preview"}
//   message        — role=assistant 时携带 usage 字段：
//                    {input, output, cacheRead, cacheWrite, reasoning, totalTokens,
//                     cost:{input,output,cacheRead,cacheWrite,total}}
//                    以及 message.model / message.provider
// ---------------------------------------------------------------------------

const PI_INDEX_VERSION = 'pi-session-v1';
const DEFAULT_TZ = 'Asia/Shanghai';

// ---------------------------------------------------------------------------
// 内部类型
// ---------------------------------------------------------------------------

interface PiTokenEvent {
  timestamp: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  cost: number;
}

interface PiSession {
  id: string;
  cwd: string;
  createdAt: string;
  tokenEvents: PiTokenEvent[];
}

interface TokenAccumulator {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  cost: number;
}

interface AggregateBucket {
  acc: TokenAccumulator;
  models: Map<string, TokenAccumulator>;
}

// ---------------------------------------------------------------------------
// 目录检测
// ---------------------------------------------------------------------------

function getPiSessionsDir(): string {
  return join(homedir(), '.pi', 'agent', 'sessions');
}

export function isPiAccessible(): boolean {
  try {
    accessSync(getPiSessionsDir(), constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 文件扫描
// ---------------------------------------------------------------------------

export function scanPiSessions(): string[] {
  const results: string[] = [];

  function walk(dir: string): void {
    let entries: string[];
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

  walk(getPiSessionsDir());
  return results.sort();
}

// ---------------------------------------------------------------------------
// 单文件解析
// ---------------------------------------------------------------------------

export function parsePiSession(filepath: string): PiSession | null {
  let content: string;
  try {
    content = readFileSync(filepath, 'utf-8');
  } catch {
    return null;
  }

  let sessionId = '';
  let cwd = '';
  let createdAt = '';
  let currentModel = '';
  const tokenEvents: PiTokenEvent[] = [];

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

    if (type === 'session') {
      sessionId = (obj.id as string) || '';
      cwd = (obj.cwd as string) || '';
      createdAt = (obj.timestamp as string) || '';
      continue;
    }

    if (type === 'model_change') {
      currentModel = (obj.modelId as string) || currentModel;
      continue;
    }

    if (type !== 'message') continue;

    const msg = obj.message as Record<string, unknown> | undefined;
    if (!msg || msg.role !== 'assistant') continue;

    const usage = msg.usage as Record<string, unknown> | undefined;
    if (!usage) continue;

    const totalTokens = (usage.totalTokens as number) || 0;
    if (totalTokens === 0) continue;

    const costObj = (usage.cost as Record<string, unknown>) || {};
    const model = (msg.model as string) || currentModel || 'unknown';
    const timestamp = (obj.timestamp as string) || '';

    tokenEvents.push({
      timestamp,
      model,
      inputTokens: (usage.input as number) || 0,
      outputTokens: (usage.output as number) || 0,
      cacheReadTokens: (usage.cacheRead as number) || 0,
      cacheWriteTokens: (usage.cacheWrite as number) || 0,
      totalTokens,
      cost: (costObj.total as number) || 0,
    });
  }

  if (!sessionId) return null;
  return { id: sessionId, cwd, createdAt, tokenEvents };
}

// ---------------------------------------------------------------------------
// 索引加载
// ---------------------------------------------------------------------------

function loadSessions(): PiSession[] {
  const result = buildUsageFileIndex<PiSession | null, { path: string }>({
    cacheName: 'pi-sessions',
    parserVersion: PI_INDEX_VERSION,
    files: scanPiSessions().map(path => ({ path })),
    parseFile: file => parsePiSession(file.path),
  });
  return result.values.filter((s): s is PiSession => s !== null);
}

// ---------------------------------------------------------------------------
// 时区 / 日期工具
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

/** Keep the full working-directory path so same-named projects do not merge. */
export function normalizePiProjectPath(cwd: string): string {
  if (!cwd) return 'unknown';
  return cwd.replace(/[\\/]+$/, '') || 'unknown';
}

// ---------------------------------------------------------------------------
// 聚合核心
// ---------------------------------------------------------------------------

function emptyAcc(): TokenAccumulator {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, cost: 0 };
}

function addEvent(acc: TokenAccumulator, ev: PiTokenEvent): void {
  acc.inputTokens += ev.inputTokens;
  acc.outputTokens += ev.outputTokens;
  acc.cacheReadTokens += ev.cacheReadTokens;
  acc.cacheWriteTokens += ev.cacheWriteTokens;
  acc.totalTokens += ev.totalTokens;
  acc.cost += ev.cost;
}

function mergeAcc(target: TokenAccumulator, source: TokenAccumulator): void {
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.cacheReadTokens += source.cacheReadTokens;
  target.cacheWriteTokens += source.cacheWriteTokens;
  target.totalTokens += source.totalTokens;
  target.cost += source.cost;
}

function addToBucket(bucket: AggregateBucket, ev: PiTokenEvent): void {
  addEvent(bucket.acc, ev);
  if (!bucket.models.has(ev.model)) bucket.models.set(ev.model, emptyAcc());
  addEvent(bucket.models.get(ev.model)!, ev);
}

function accToEntry(date: string, acc: TokenAccumulator, modelAccs: Map<string, TokenAccumulator>): DailyEntry {
  const modelBreakdowns: ModelBreakdown[] = [...modelAccs.entries()].map(([modelName, m]) => ({
    modelName,
    inputTokens: m.inputTokens,
    outputTokens: m.outputTokens,
    cacheCreationTokens: m.cacheWriteTokens,
    cacheReadTokens: m.cacheReadTokens,
    cost: m.cost,
  }));
  return {
    date,
    inputTokens: acc.inputTokens,
    outputTokens: acc.outputTokens,
    cacheCreationTokens: acc.cacheWriteTokens,
    cacheReadTokens: acc.cacheReadTokens,
    totalTokens: acc.totalTokens,
    totalCost: acc.cost,
    modelsUsed: [...modelAccs.keys()],
    modelBreakdowns,
  };
}

function groupSessions(
  sessions: PiSession[],
  groupBy: 'day' | 'hour' | 'project',
  tz: string,
  projectFilter?: string | null,
): Map<string, AggregateBucket> {
  const grouped = new Map<string, AggregateBucket>();

  for (const session of sessions) {
    const projectName = normalizePiProjectPath(session.cwd);
    if (projectFilter && projectName !== projectFilter) continue;

    for (const ev of session.tokenEvents) {
      let key: string;
      if (groupBy === 'hour') {
        key = getHourKey(ev.timestamp, tz);
      } else if (groupBy === 'project') {
        key = projectName;
      } else {
        key = getDateKey(ev.timestamp, tz);
      }
      if (!grouped.has(key)) grouped.set(key, { acc: emptyAcc(), models: new Map() });
      addToBucket(grouped.get(key)!, ev);
    }
  }

  return grouped;
}

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

export function getDailyResponse(options?: { timezone?: string }): DailyResponse {
  const tz = options?.timezone || DEFAULT_TZ;
  const sessions = loadSessions();
  const grouped = groupSessions(sessions, 'day', tz);

  const daily: DailyEntry[] = [];
  const totalsAcc = emptyAcc();
  const totalModels = new Map<string, TokenAccumulator>();

  for (const [date, { acc, models }] of grouped) {
    daily.push(accToEntry(date, acc, models));
    mergeAcc(totalsAcc, acc);
    for (const [model, m] of models) {
      if (!totalModels.has(model)) totalModels.set(model, emptyAcc());
      mergeAcc(totalModels.get(model)!, m);
    }
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

export function getProjectsResponse(options?: { timezone?: string }): ProjectsResponse {
  const tz = options?.timezone || DEFAULT_TZ;
  const sessions = loadSessions();

  // 按项目 → 日期二级分组
  const projectDaily = new Map<string, Map<string, AggregateBucket>>();

  for (const session of sessions) {
    const projectName = normalizePiProjectPath(session.cwd);
    if (!projectDaily.has(projectName)) projectDaily.set(projectName, new Map());
    const dailyMap = projectDaily.get(projectName)!;

    for (const ev of session.tokenEvents) {
      const dayKey = getDateKey(ev.timestamp, tz);
      if (!dailyMap.has(dayKey)) dailyMap.set(dayKey, { acc: emptyAcc(), models: new Map() });
      addToBucket(dailyMap.get(dayKey)!, ev);
    }
  }

  const projects: Record<string, DailyEntry[]> = {};
  for (const [projectName, dailyMap] of projectDaily) {
    projects[projectName] = [...dailyMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, { acc, models }]) => accToEntry(date, acc, models));
  }

  return { projects };
}

export function getBlocksResponse(options?: { project?: string | null; timezone?: string }): BlocksResponse {
  const tz = options?.timezone || DEFAULT_TZ;
  const sessions = loadSessions();
  const grouped = groupSessions(sessions, 'hour', tz, options?.project);

  const blocks: BlockEntry[] = [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([hourKey, { acc, models }], idx) => {
      const [datePart, timePart] = hourKey.split(' ');
      const hour = timePart.split(':')[0];
      return {
        id: `pi-hour-${idx}`,
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
        models: [...models.keys()],
      };
    });

  return { blocks };
}
