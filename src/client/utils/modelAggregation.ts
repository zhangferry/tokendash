import type { DailyEntry } from '../../shared/types.js';

export function modelTokenMode(entry: DailyEntry): 'inputOutput' | 'withCache' {
  const inputOutput = entry.modelBreakdowns.reduce((sum, b) => sum + b.inputTokens + b.outputTokens, 0);
  const withCache = entry.modelBreakdowns.reduce((sum, b) => sum + b.inputTokens + b.outputTokens + b.cacheReadTokens, 0);
  return Math.abs(entry.totalTokens - inputOutput) <= Math.abs(entry.totalTokens - withCache) ? 'inputOutput' : 'withCache';
}

export function modelBreakdownTokens(breakdown: DailyEntry['modelBreakdowns'][number], mode: 'inputOutput' | 'withCache'): number {
  const base = breakdown.inputTokens + breakdown.outputTokens;
  return mode === 'withCache' ? base + breakdown.cacheReadTokens : base;
}
