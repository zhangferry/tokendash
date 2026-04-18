import { describe, it, expect } from 'vitest';
import { cacheHitRate, costSavedByCache } from '../../client/utils/cacheCalculations.js';

describe('cacheHitRate', () => {
  it('returns 0 when input tokens is 0', () => {
    expect(cacheHitRate(1000, 0)).toBe(0);
  });

  it('calculates hit rate as percentage', () => {
    // cacheHitRate(cacheReadTokens, inputTokens) = cacheRead / input * 100
    expect(cacheHitRate(500, 1000)).toBe(50);
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
