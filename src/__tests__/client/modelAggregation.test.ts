import { describe, it, expect } from 'vitest';
import { modelTokenMode, modelBreakdownTokens } from '../../client/utils/modelAggregation.js';
import type { DailyEntry } from '../../shared/types.js';

function makeEntry(overrides: Partial<DailyEntry> & Pick<DailyEntry, 'totalTokens' | 'modelBreakdowns'>): DailyEntry {
  return {
    date: '2026-05-19',
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalCost: 0,
    modelsUsed: [],
    ...overrides,
  };
}

describe('modelTokenMode', () => {
  it('returns inputOutput when totalTokens matches input+output', () => {
    const entry = makeEntry({
      totalTokens: 3_000,
      modelBreakdowns: [
        { modelName: 'claude-sonnet', inputTokens: 1_000, outputTokens: 500, cacheCreationTokens: 0, cacheReadTokens: 200, cost: 0 },
        { modelName: 'gpt-5.4', inputTokens: 1_000, outputTokens: 500, cacheCreationTokens: 0, cacheReadTokens: 300, cost: 0 },
      ],
    });

    expect(modelTokenMode(entry)).toBe('inputOutput');
  });

  it('returns withReadCache when totalTokens is closer to input+output+cacheRead', () => {
    const entry = makeEntry({
      totalTokens: 3_500,
      modelBreakdowns: [
        { modelName: 'claude-sonnet', inputTokens: 1_000, outputTokens: 500, cacheCreationTokens: 0, cacheReadTokens: 1_000, cost: 0 },
        { modelName: 'gpt-5.4', inputTokens: 500, outputTokens: 500, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0 },
      ],
    });

    // inputOutput sum = 1000+500+500+500 = 2500, diff from 3500 = 1000
    // withReadCache sum = 2500+1000 = 3500, diff from 3500 = 0
    expect(modelTokenMode(entry)).toBe('withReadCache');
  });

  it('returns withAllCache when totalTokens includes cache creation and cache read', () => {
    const entry = makeEntry({
      totalTokens: 3_700,
      modelBreakdowns: [
        { modelName: 'claude-sonnet', inputTokens: 1_000, outputTokens: 500, cacheCreationTokens: 200, cacheReadTokens: 1_000, cost: 0 },
        { modelName: 'gpt-5.4', inputTokens: 500, outputTokens: 500, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0 },
      ],
    });

    expect(modelTokenMode(entry)).toBe('withAllCache');
  });

  it('returns inputOutput for Claude-style entries where totalTokens = input + output', () => {
    const entry = makeEntry({
      totalTokens: 1_050,
      modelBreakdowns: [
        { modelName: 'claude-sonnet', inputTokens: 1_000, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0 },
      ],
    });

    expect(modelTokenMode(entry)).toBe('inputOutput');
  });

  it('handles empty model breakdowns', () => {
    const entry = makeEntry({
      totalTokens: 0,
      modelBreakdowns: [],
    });

    expect(modelTokenMode(entry)).toBe('inputOutput');
  });
});

describe('modelBreakdownTokens', () => {
  const breakdown = {
    modelName: 'claude-sonnet',
    inputTokens: 1_000,
    outputTokens: 200,
    cacheCreationTokens: 0,
    cacheReadTokens: 500,
    cost: 0,
  };

  it('returns input+output in inputOutput mode', () => {
    expect(modelBreakdownTokens(breakdown, 'inputOutput')).toBe(1_200);
  });

  it('returns input+output+cacheRead in withCache mode', () => {
    expect(modelBreakdownTokens(breakdown, 'withReadCache')).toBe(1_700);
  });

  it('returns input+output+cacheCreation+cacheRead in withAllCache mode', () => {
    const withCreate = { ...breakdown, cacheCreationTokens: 300 };
    expect(modelBreakdownTokens(withCreate, 'withAllCache')).toBe(2_000);
  });

  it('returns input+output when cacheRead is zero regardless of mode', () => {
    const noCache = { ...breakdown, cacheReadTokens: 0 };
    expect(modelBreakdownTokens(noCache, 'inputOutput')).toBe(1_200);
    expect(modelBreakdownTokens(noCache, 'withReadCache')).toBe(1_200);
  });
});
