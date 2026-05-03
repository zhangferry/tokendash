import { describe, expect, it } from 'vitest';
import { buildHourlyConsumption } from '../../client/utils/hourlyConsumption.js';
import type { BlockEntry } from '../../shared/types.js';

function makeBlock(hour: number, overrides: Partial<BlockEntry> = {}): BlockEntry {
  return {
    id: `block-${hour}`,
    startTime: `2026-05-03T${String(hour).padStart(2, '0')}:00:00`,
    endTime: `2026-05-03T${String(hour).padStart(2, '0')}:59:59`,
    actualEndTime: null,
    isActive: false,
    isGap: false,
    entries: 1,
    tokenCounts: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
    totalTokens: 100 * (hour + 1),
    costUSD: Number(((hour + 1) * 0.25).toFixed(2)),
    models: [],
    ...overrides,
  };
}

describe('buildHourlyConsumption', () => {
  it('returns 24 buckets and preserves empty hours', () => {
    const summary = buildHourlyConsumption(
      [makeBlock(0), makeBlock(3), makeBlock(3, { totalTokens: 50, costUSD: 0.1 })],
      new Date('2026-05-03T08:30:00'),
    );

    expect(summary.buckets).toHaveLength(24);
    expect(summary.buckets[1].tokens).toBe(0);
    expect(summary.buckets[3].tokens).toBe(450);
    expect(summary.buckets[3].cost).toBeCloseTo(1.1, 5);
    expect(summary.buckets[8].isCurrentHour).toBe(true);
    expect(summary.buckets[9].isFutureHour).toBe(true);
    expect(summary.peakHour).toBe(3);
  });

  it('ignores gap blocks and blocks from other dates', () => {
    const summary = buildHourlyConsumption(
      [
        makeBlock(2),
        makeBlock(5, { isGap: true }),
        makeBlock(4, { startTime: '2026-05-02T04:00:00' }),
      ],
      new Date('2026-05-03T10:00:00'),
    );

    expect(summary.buckets[2].tokens).toBe(300);
    expect(summary.buckets[4].tokens).toBe(0);
    expect(summary.buckets[5].tokens).toBe(0);
  });
});
