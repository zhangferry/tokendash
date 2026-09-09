import { claudeUsageLines } from './claudeUsageLines.js';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { DailyEntry, DailyResponse, ProjectsResponse, Totals, BlockEntry } from '../shared/types.js';
import { buildUsageFileIndex } from './usageFileIndex.js';

// ---------------------------------------------------------------------------
// Model pricing (USD per 1M tokens)
// Update from https://docs.anthropic.com/en/docs/about-claude/models when needed
// ---------------------------------------------------------------------------

interface ModelPricing {
  inputPer1M: number;
  cacheCreationPer1M: number;
  cacheReadPer1M: number;
  outputPer1M: number;
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  // Claude 4.6
  'claude-opus-4-6': { inputPer1M: 15, cacheCreationPer1M: 18.75, cacheReadPer1M: 1.50, outputPer1M: 75 },
  'claude-sonnet-4-6': { inputPer1M: 3, cacheCreationPer1M: 3.75, cacheReadPer1M: 0.30, outputPer1M: 15 },
  // Claude 4.5
  'claude-sonnet-4-5-20250514': { inputPer1M: 3, cacheCreationPer1M: 3.75, cacheReadPer1M: 0.30, outputPer1M: 15 },
  'claude-haiku-4-5-20251001': { inputPer1M: 0.80, cacheCreationPer1M: 1, cacheReadPer1M: 0.08, outputPer1M: 4 },
  // Older Claude models
  'claude-3-5-sonnet-20241022': { inputPer1M: 3, cacheCreationPer1M: 3.75, cacheReadPer1M: 0.30, outputPer1M: 15 },
  'claude-3-5-haiku-20241022': { inputPer1M: 0.80, cacheCreationPer1M: 1, cacheReadPer1M: 0.08, outputPer1M: 4 },
  'claude-3-opus-20240229': { inputPer1M: 15, cacheCreationPer1M: 18.75, cacheReadPer1M: 1.50, outputPer1M: 75 },
  'claude-3-haiku-20240307': { inputPer1M: 0.25, cacheCreationPer1M: 0.30, cacheReadPer1M: 0.03, outputPer1M: 1.25 },
};

const DEFAULT_PRICING: ModelPricing = { inputPer1M: 3, cacheCreationPer1M: 3.75, cacheReadPer1M: 0.30, outputPer1M: 15 };

function getPricing(model: string): ModelPricing {
  // Try exact match first, then prefix match
  if (MODEL_PRICING[model]) return MODEL_PRICING[model];
  const lower = model.toLowerCase();
  for (const key of Object.keys(MODEL_PRICING)) {
    if (lower.startsWith(key) || lower.includes(key)) return MODEL_PRICING[key];
  }
  return DEFAULT_PRICING;
}

export function calculateCost(inputTokens: number, cacheReadTokens: number, outputTokens: number, model: string, cacheCreationTokens = 0): number {
  const p = getPricing(model);
  return (inputTokens / 1_000_000) * p.inputPer1M
    + (cacheCreationTokens / 1_000_000) * p.cacheCreationPer1M
    + (cacheReadTokens / 1_000_000) * p.cacheReadPer1M
    + (outputTokens / 1_000_000) * p.outputPer1M;
}

function totalClaudeTokens(inputTokens: number, outputTokens: number, cacheCreationTokens: number, cacheReadTokens: number): number {
  return inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens;
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

interface ClaudeUsageFileRef {
  path: string;
  projectDir: string;
}

interface ClaudeModelBucket {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  cost: number;
}

interface ClaudeAggregateBucket {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  totalCost: number;
  models: Record<string, ClaudeModelBucket>;
}

interface ClaudeFileAggregate {
  daily: Record<string, ClaudeAggregateBucket>;
  projects: Record<string, Record<string, ClaudeAggregateBucket>>;
  blocks: Record<string, ClaudeAggregateBucket>;
  projectBlocks: Record<string, Record<string, ClaudeAggregateBucket>>;
}

// ---------------------------------------------------------------------------
// JSONL parsing with mtime cache
// ---------------------------------------------------------------------------

const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');
const CLAUDE_INDEX_VERSION = 'claude-aggregate-v3-1min';

const projectNameCache = new Map<string, string>();

/** Decode Claude's encoded project directory name.
 *  Claude encodes paths: /Users/foo/bar → -Users-foo-bar
 *  Since '-' replaces '/' and project names can contain '-',
 *  we use filesystem checks to find the correct last segment.
 */
export function extractProjectName(dirName: string): string {
  if (!dirName.startsWith('-')) return dirName;

  const cached = projectNameCache.get(dirName);
  if (cached) return cached;

  const segments = dirName.replace(/^-/, '').split('-').filter(Boolean);
  if (segments.length === 0) { projectNameCache.set(dirName, dirName); return dirName; }
  if (segments.length === 1) { projectNameCache.set(dirName, segments[0]); return segments[0]; }

  let bestName = segments[segments.length - 1];

  // Try from right: find the longest last segment that forms a valid path
  for (let splitAt = segments.length - 1; splitAt >= 1; splitAt--) {
    const parentSegments = segments.slice(0, splitAt);
    const candidateName = segments.slice(splitAt).join('-');

    // Build parent path, handling hidden directories (dot prefix)
    let parentPath = '/';
    let valid = true;
    for (const seg of parentSegments) {
      const regular = join(parentPath, seg);
      const hidden = join(parentPath, '.' + seg);
      if (existsSync(regular)) {
        parentPath = regular;
      } else if (existsSync(hidden)) {
        parentPath = hidden;
      } else {
        valid = false;
        break;
      }
    }

    if (!valid) continue;

    if (existsSync(join(parentPath, candidateName)) || existsSync(join(parentPath, '.' + candidateName))) {
      bestName = candidateName;
      break;
    }
  }

  projectNameCache.set(dirName, bestName);
  return bestName;
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

function collectClaudeUsageFiles(): ClaudeUsageFileRef[] {
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return [];

  const files: ClaudeUsageFileRef[] = [];
  const projectDirs = readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  for (const dirName of projectDirs) {
    const dirPath = join(CLAUDE_PROJECTS_DIR, dirName);
    files.push(...findJsonlFiles(dirPath).map(path => ({ path, projectDir: dirName })));
  }

  return files;
}

function parseClaudeUsageFile(file: ClaudeUsageFileRef): ClaudeFileAggregate {
  const summary: ClaudeFileAggregate = { daily: {}, projects: {}, blocks: {}, projectBlocks: {} };
  let content: string;
  try {
    content = readFileSync(file.path, 'utf-8');
  } catch {
    return summary;
  }
  const projectName = extractProjectName(file.projectDir);
  const lines = content.split('\n');
  const usageLines = claudeUsageLines(lines);

  for (const [lineIndex, line] of lines.entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let obj: Record<string, unknown>;
    try { obj = JSON.parse(trimmed) as Record<string, unknown>; } catch { continue; }

    if (obj.type !== 'assistant' || !obj.message) continue;
    const msg = obj.message as Record<string, unknown>;
    if (!usageLines.has(lineIndex)) continue;
    const usage = (msg.usage as Record<string, number>) || {};

    const inputTokens = usage.input_tokens || 0;
    const outputTokens = usage.output_tokens || 0;
    const cacheCreationTokens = usage.cache_creation_input_tokens || 0;
    const cacheReadTokens = usage.cache_read_input_tokens || 0;
    const totalTokens = totalClaudeTokens(inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens);

    if (totalTokens === 0) continue;

    const timestamp = obj.timestamp as string;
    const parsedUsage = {
      model: (msg.model as string) || 'unknown',
      inputTokens,
      outputTokens,
      cacheCreationTokens,
      cacheReadTokens,
    };
    const dayKey = getDateKey(timestamp, DEFAULT_TZ);
    const bucketKey = getMinuteKey(timestamp, DEFAULT_TZ);

    addUsageToBucket(claudeBucketFor(summary.daily, dayKey), parsedUsage);
    addUsageToBucket(claudeBucketFor(summary.blocks, bucketKey), parsedUsage);

    if (!summary.projects[projectName]) summary.projects[projectName] = {};
    addUsageToBucket(claudeBucketFor(summary.projects[projectName], dayKey), parsedUsage);

    if (!summary.projectBlocks[projectName]) summary.projectBlocks[projectName] = {};
    addUsageToBucket(claudeBucketFor(summary.projectBlocks[projectName], bucketKey), parsedUsage);
  }

  return summary;
}

function loadClaudeAggregates(): ClaudeFileAggregate[] {
  const result = buildUsageFileIndex<ClaudeFileAggregate, ClaudeUsageFileRef>({
    cacheName: 'claude-usage',
    parserVersion: CLAUDE_INDEX_VERSION,
    files: collectClaudeUsageFiles(),
    parseFile: parseClaudeUsageFile,
  });
  return result.values;
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

export type BlockGranularity = 'hour' | '15m' | '5m' | '1m';

const GRANULARITY_MINUTES: Record<BlockGranularity, number> = { hour: 60, '15m': 15, '5m': 5, '1m': 1 };

/// Bucket key at a fixed 1-minute granularity — the parse/index layer always
/// produces this fine base so cached summaries stay granularity-agnostic.
export function getMinuteKey(timestamp: string, tz: string): string {
  const offset = (TZ_OFFSETS[tz] ?? 8) * 3_600_000;
  const d = new Date(new Date(timestamp).getTime() + offset);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const minute = String(d.getUTCMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${hh}:${minute}`;
}

/// Coarsen a 1-minute bucket key ('yyyy-MM-ddTHH:mm') up to the requested
/// granularity. 'hour' yields the legacy getHourKey format ('yyyy-MM-ddTHH').
export function coarsenBucketKey(key: string, granularity: BlockGranularity): string {
  if (granularity === '1m') return key;
  if (granularity === 'hour') return key.slice(0, 13);   // 'yyyy-MM-ddTHH'
  const minutes = GRANULARITY_MINUTES[granularity];
  const minute = String(Math.floor(Number(key.slice(14, 16)) / minutes) * minutes).padStart(2, '0');
  return `${key.slice(0, 14)}${minute}`;
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

function emptyClaudeBucket(): ClaudeAggregateBucket {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    totalCost: 0,
    models: {},
  };
}

function claudeBucketFor(map: Record<string, ClaudeAggregateBucket>, key: string): ClaudeAggregateBucket {
  if (!map[key]) map[key] = emptyClaudeBucket();
  return map[key];
}

function addUsageToBucket(bucket: ClaudeAggregateBucket, usage: Omit<ParsedUsage, 'projectDir' | 'timestamp'>): void {
  bucket.inputTokens += usage.inputTokens;
  bucket.outputTokens += usage.outputTokens;
  bucket.cacheCreationTokens += usage.cacheCreationTokens;
  bucket.cacheReadTokens += usage.cacheReadTokens;
  bucket.totalTokens += totalClaudeTokens(
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheCreationTokens,
    usage.cacheReadTokens,
  );
  const cost = calculateCost(
    usage.inputTokens,
    usage.cacheReadTokens,
    usage.outputTokens,
    usage.model,
    usage.cacheCreationTokens,
  );
  bucket.totalCost += cost;

  if (!bucket.models[usage.model]) {
    bucket.models[usage.model] = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, cost: 0 };
  }
  const model = bucket.models[usage.model];
  model.input += usage.inputTokens;
  model.output += usage.outputTokens;
  model.cacheCreation += usage.cacheCreationTokens;
  model.cacheRead += usage.cacheReadTokens;
  model.cost += cost;
}

function mergeClaudeBucket(target: ClaudeAggregateBucket, source: ClaudeAggregateBucket): void {
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.cacheCreationTokens += source.cacheCreationTokens;
  target.cacheReadTokens += source.cacheReadTokens;
  target.totalTokens += source.totalTokens;
  target.totalCost += source.totalCost;

  for (const [modelName, model] of Object.entries(source.models)) {
    if (!target.models[modelName]) {
      target.models[modelName] = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, cost: 0 };
    }
    const targetModel = target.models[modelName];
    targetModel.input += model.input;
    targetModel.output += model.output;
    targetModel.cacheCreation += model.cacheCreation;
    targetModel.cacheRead += model.cacheRead;
    targetModel.cost += model.cost;
  }
}

function dailyEntryFromBucket(date: string, bucket: ClaudeAggregateBucket): DailyEntry {
  return toDailyEntry({
    date,
    inputTokens: bucket.inputTokens,
    outputTokens: bucket.outputTokens,
    cacheCreationTokens: bucket.cacheCreationTokens,
    cacheReadTokens: bucket.cacheReadTokens,
    totalTokens: bucket.totalTokens,
    totalCost: bucket.totalCost,
    models: new Map(Object.entries(bucket.models)),
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const DEFAULT_TZ = 'Asia/Shanghai';

export function getDailyResponse(project?: string | null, tz = DEFAULT_TZ): DailyResponse {
  const dayBuckets: Record<string, ClaudeAggregateBucket> = {};

  for (const summary of loadClaudeAggregates()) {
    const source = project ? summary.projects[extractProjectName(project)] || {} : summary.daily;
    for (const [date, bucket] of Object.entries(source)) {
      mergeClaudeBucket(claudeBucketFor(dayBuckets, date), bucket);
    }
  }

  const daily = Object.entries(dayBuckets)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, bucket]) => dailyEntryFromBucket(date, bucket));
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
  const projectBuckets: Record<string, Record<string, ClaudeAggregateBucket>> = {};

  for (const summary of loadClaudeAggregates()) {
    for (const [projectName, dailyBuckets] of Object.entries(summary.projects)) {
      if (!projectBuckets[projectName]) projectBuckets[projectName] = {};
      for (const [date, bucket] of Object.entries(dailyBuckets)) {
        mergeClaudeBucket(claudeBucketFor(projectBuckets[projectName], date), bucket);
      }
    }
  }

  const projects: Record<string, DailyEntry[]> = {};
  for (const [projectName, dailyBuckets] of Object.entries(projectBuckets)) {
    projects[projectName] = Object.entries(dailyBuckets)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, bucket]) => dailyEntryFromBucket(date, bucket));
  }

  return { projects };
}

export function getBlocksResponse(
  project?: string | null,
  tz = DEFAULT_TZ,
  granularity: BlockGranularity = 'hour',
): { blocks: BlockEntry[] } {
  const minuteBuckets: Record<string, ClaudeAggregateBucket> = {};

  for (const summary of loadClaudeAggregates()) {
    const source = project ? summary.projectBlocks[extractProjectName(project)] || {} : summary.blocks;
    for (const [key, bucket] of Object.entries(source)) {
      mergeClaudeBucket(claudeBucketFor(minuteBuckets, coarsenBucketKey(key, granularity)), bucket);
    }
  }

  const granMinutes = GRANULARITY_MINUTES[granularity];
  // 1-minute responses cover only the trailing 15 minutes — the realtime tab
  // polls every 60s and must not pull the full minute-level history.
  const windowStartKey = granularity === '1m'
    ? getMinuteKey(new Date(Date.now() - 15 * 60_000).toISOString(), tz)
    : '';
  const blocks: BlockEntry[] = Object.entries(minuteBuckets)
    .filter(([key]) => !windowStartKey || key >= windowStartKey)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, bucket], idx) => ({
      id: `claude-${idx}`,
      startTime: granularity === 'hour' ? `${key}:00:00` : `${key}:00`,
      endTime: granularity === 'hour'
        ? `${key}:59:59`
        : `${key.slice(0, 14)}${String(Number(key.slice(14, 16)) + granMinutes - 1).padStart(2, '0')}:59`,
      actualEndTime: null,
      isActive: false,
      isGap: false,
      entries: bucket.totalTokens > 0 ? 1 : 0,
      tokenCounts: {
        inputTokens: bucket.inputTokens,
        outputTokens: bucket.outputTokens,
        cacheCreationInputTokens: bucket.cacheCreationTokens,
        cacheReadInputTokens: bucket.cacheReadTokens,
      },
      totalTokens: bucket.totalTokens,
      costUSD: Math.round(bucket.totalCost * 10000) / 10000,
      models: Object.keys(bucket.models),
    }));
  return { blocks };
}
