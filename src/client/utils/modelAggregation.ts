import type { DailyEntry } from '../../shared/types.js';

export function modelTokenMode(entry: DailyEntry): 'inputOutput' | 'withReadCache' | 'withAllCache' {
  const inputOutput = entry.modelBreakdowns.reduce((sum, b) => sum + b.inputTokens + b.outputTokens, 0);
  const withReadCache = entry.modelBreakdowns.reduce((sum, b) => sum + b.inputTokens + b.outputTokens + b.cacheReadTokens, 0);
  const withAllCache = entry.modelBreakdowns.reduce((sum, b) => sum + b.inputTokens + b.outputTokens + b.cacheCreationTokens + b.cacheReadTokens, 0);
  const candidates = [
    { mode: 'inputOutput' as const, diff: Math.abs(entry.totalTokens - inputOutput) },
    { mode: 'withReadCache' as const, diff: Math.abs(entry.totalTokens - withReadCache) },
    { mode: 'withAllCache' as const, diff: Math.abs(entry.totalTokens - withAllCache) },
  ];
  return candidates.reduce((best, candidate) => candidate.diff < best.diff ? candidate : best).mode;
}

export function modelBreakdownTokens(breakdown: DailyEntry['modelBreakdowns'][number], mode: ReturnType<typeof modelTokenMode>): number {
  const base = breakdown.inputTokens + breakdown.outputTokens;
  if (mode === 'withAllCache') return base + breakdown.cacheCreationTokens + breakdown.cacheReadTokens;
  if (mode === 'withReadCache') return base + breakdown.cacheReadTokens;
  return base;
}
