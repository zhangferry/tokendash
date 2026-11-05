import { afterEach, describe, expect, it, vi } from 'vitest';
import { derivePopoverData, loadPopoverUsage } from '../../popover/usePopoverData.js';
import type { DailyResponse } from '../../shared/types.js';

const now = new Date(2026, 10, 5, 12);
function daily(costAvailable?: boolean): DailyResponse {
  const entry = { date: '2026-11-05', inputTokens: 10, outputTokens: 5, cacheReadTokens: 20, cacheCreationTokens: 3, totalTokens: 38, totalCost: 0.1, estimatedTokens: 0, costAvailable, modelsUsed: ['deepseek-flash'], modelBreakdowns: [{ modelName: 'deepseek-flash', inputTokens: 10, outputTokens: 5, cacheReadTokens: 20, cacheCreationTokens: 3, totalTokens: 38, cost: 0.1, estimatedTokens: 0, costAvailable }] };
  return { daily: [entry], totals: { ...entry } };
}
function reply(body: unknown, ok = true) { return { ok, status: ok ? 200 : 502, statusText: 'Bad Gateway', json: async () => body }; }

afterEach(() => vi.unstubAllGlobals());

describe('popover DeepSeek usage', () => {
  it('includes every token bucket and carries unknown pricing through summary, model and trend', () => {
    const data = derivePopoverData([daily(true), daily(false)], [], now);
    expect(data.summary).toMatchObject({ tokens: 76, cost: 0.2, cacheWriteTokens: 6, costAvailable: false });
    expect(data.models[0]).toMatchObject({ tokens: 76, costAvailable: false });
    expect(data.trend.at(-1)).toMatchObject({ tokens: 76, costAvailable: false });
  });

  it('marks estimates incomplete when a source is missing even if the surviving models are priced', () => {
    const data = derivePopoverData([daily(true)], [], now, true);
    expect(data.summary?.costAvailable).toBe(false);
    expect(data.models[0].costAvailable).toBe(false);
    expect(data.trend.at(-1)?.costAvailable).toBe(false);
  });

  it('keeps the healthy source and rejects total failures so the hook retains its previous view', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input, 'http://localhost');
      if (url.searchParams.get('agent') === 'deepseek') return reply({ hint: 'Install zstd' }, false);
      return reply(url.pathname.endsWith('daily') ? daily(true) : { blocks: [] });
    }));
    const result = await loadPopoverUsage(['claude', 'deepseek'], true);
    expect(result.daily).toHaveLength(1);
    expect(result.sourceErrors).toEqual([{ agent: 'deepseek', message: 'Install zstd' }]);
    await expect(loadPopoverUsage(['deepseek'], true)).rejects.toThrow('Install zstd');
  });

  it('does not mix a source daily summary with a failed block response', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input, 'http://localhost');
      if (url.pathname.endsWith('blocks') && url.searchParams.get('agent') === 'deepseek') return reply({ hint: 'Corrupt block source' }, false);
      return reply(url.pathname.endsWith('daily') ? daily(true) : { blocks: [] });
    }));
    const result = await loadPopoverUsage(['claude', 'deepseek'], true);
    expect(result.daily).toHaveLength(1);
    expect(result.blocks).toHaveLength(1);
    expect(result.sourceErrors[0].agent).toBe('deepseek');
  });
});
