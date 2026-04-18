import { describe, it, expect } from 'vitest';
import { calculateCost, getDateKey, getHourKey } from '../../server/claudeJsonlParser.js';

describe('calculateCost', () => {
  it('calculates sonnet cost correctly', () => {
    // Sonnet: $3/M input, $0.30/M cache read, $15/M output
    const cost = calculateCost(1_000_000, 0, 1_000_000, 'claude-sonnet-4-6');
    // input: 1M * $3 = $3, output: 1M * $15 = $15 → $18
    expect(cost).toBeCloseTo(18, 2);
  });

  it('calculates opus cost correctly', () => {
    // Opus: $15/M input, $1.50/M cache read, $75/M output
    const cost = calculateCost(1_000_000, 0, 1_000_000, 'claude-opus-4-6');
    // input: 1M * $15 = $15, output: 1M * $75 = $75 → $90
    expect(cost).toBeCloseTo(90, 2);
  });

  it('uses default pricing for unknown models', () => {
    // Default = sonnet pricing: $3/M input, $0.30/M cache, $15/M output
    const cost = calculateCost(1_000_000, 0, 1_000_000, 'some-future-model');
    expect(cost).toBeCloseTo(18, 2);
  });

  it('charges cache read at reduced rate', () => {
    const costWithCache = calculateCost(0, 1_000_000, 0, 'claude-sonnet-4-6');
    // Cache read: 1M * $0.30 = $0.30
    expect(costWithCache).toBeCloseTo(0.30, 2);
  });

  it('deducts cache read from input tokens', () => {
    // 1M input with 500K cache read → 500K non-cached input + 500K cache read
    const cost = calculateCost(1_000_000, 500_000, 0, 'claude-sonnet-4-6');
    // non-cached: 500K * $3 = $1.50, cache: 500K * $0.30 = $0.15 → $1.65
    expect(cost).toBeCloseTo(1.65, 2);
  });
});

describe('getDateKey', () => {
  it('converts UTC timestamp to Asia/Shanghai date', () => {
    // 2026-04-15T08:00:00Z = 2026-04-15 16:00 in UTC+8
    const key = getDateKey('2026-04-15T08:00:00.000Z', 'Asia/Shanghai');
    expect(key).toBe('2026-04-15');
  });

  it('rolls over to next day after midnight in timezone', () => {
    // 2026-04-15T16:00:00Z = 2026-04-16 00:00 in UTC+8
    const key = getDateKey('2026-04-15T16:00:00.000Z', 'Asia/Shanghai');
    expect(key).toBe('2026-04-16');
  });

  it('handles UTC timezone', () => {
    const key = getDateKey('2026-04-15T08:00:00.000Z', 'UTC');
    expect(key).toBe('2026-04-15');
  });

  it('handles America/New_York negative offset', () => {
    // 2026-04-15T04:00:00Z = 2026-04-14 23:00 in EST (UTC-5)
    const key = getDateKey('2026-04-15T04:00:00.000Z', 'America/New_York');
    expect(key).toBe('2026-04-14');
  });

  it('defaults to Asia/Shanghai for unknown timezone', () => {
    const key = getDateKey('2026-04-15T08:00:00.000Z', 'Unknown/TZ');
    expect(key).toBe('2026-04-15'); // defaults to UTC+8
  });
});

describe('getHourKey', () => {
  it('produces correct hour key for Asia/Shanghai', () => {
    // 2026-04-15T08:00:00Z = 16:00 in UTC+8
    const key = getHourKey('2026-04-15T08:00:00.000Z', 'Asia/Shanghai');
    expect(key).toBe('2026-04-15T16');
  });

  it('rolls over hour at midnight boundary', () => {
    // 2026-04-15T16:00:00Z = 00:00 next day in UTC+8
    const key = getHourKey('2026-04-15T16:00:00.000Z', 'Asia/Shanghai');
    expect(key).toBe('2026-04-16T00');
  });
});
