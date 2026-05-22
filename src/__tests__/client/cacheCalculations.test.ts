import { describe, it, expect } from 'vitest';
import { cacheHitRate, costSavedByCache } from '../../client/utils/cacheCalculations.js';

describe('cacheHitRate', () => {
  it('calculates hit rate from all input-like tokens', () => {
    expect(cacheHitRate(500, 1000)).toBeCloseTo((500 / 1500) * 100, 5);
  });

  it('stays below 100% when cache reads exceed fresh input', () => {
    expect(cacheHitRate(300_000, 10_000)).toBeCloseTo(96.774, 3);
  });

  it('returns 100% when only cached input is present', () => {
    expect(cacheHitRate(1000, 0)).toBe(100);
  });

  it('returns 0 when both are 0', () => {
    expect(cacheHitRate(0, 0)).toBe(0);
  });
});

describe('costSavedByCache', () => {
  it('calculates cost savings from cache reads', () => {
    // Formula: (cacheReadTokens / 1M) * $3.0 * (1 - 0.1) = tokens/1M * $2.70
    const saved = costSavedByCache(1_000_000);
    // 1M * 3.0 * 0.9 = $2.70
    expect(saved).toBeCloseTo(2.70, 2);
  });

  it('returns 0 when no cache reads', () => {
    expect(costSavedByCache(0)).toBe(0);
  });
});
