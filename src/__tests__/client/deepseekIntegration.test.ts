import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAnalytics, fetchBlocks, fetchDaily, fetchProjects } from '../../client/api/client.js';
import { mergeDailyResponses, mergeProjects } from '../../client/utils/agentAggregation.js';
import type { BlockEntry, DailyEntry, DailyResponse } from '../../shared/types.js';

function day(costAvailable?: boolean): DailyEntry {
  return {
    date: '2026-11-05', inputTokens: 10, outputTokens: 5, cacheReadTokens: 20, cacheCreationTokens: 3,
    totalTokens: 38, totalCost: 0.1, estimatedTokens: 0, modelsUsed: ['deepseek-flash'], costAvailable,
    modelBreakdowns: [{ modelName: 'deepseek-flash', inputTokens: 10, outputTokens: 5, cacheReadTokens: 20, cacheCreationTokens: 3, totalTokens: 38, cost: 0.1, estimatedTokens: 0, costAvailable }],
  };
}
function daily(costAvailable?: boolean): DailyResponse {
  const entry = day(costAvailable);
  return { daily: [entry], totals: { ...entry } };
}
const block: BlockEntry = { id: 'one', startTime: '2026-11-05T10:00:00', endTime: '2026-11-05T11:00:00', actualEndTime: null, isActive: false, isGap: false, entries: 1, totalTokens: 38, costUSD: 0.1, costAvailable: false, models: ['deepseek-flash'], tokenCounts: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 20, cacheCreationInputTokens: 3 } };
const analytics = { codeChangeTrend: [], toolUsageDistribution: [{ name: 'bash', count: 1 }], toolCallTrend: [], productivityKPIs: { avgLinesPerEdit: 0, filesModifiedPerDay: 0, addDeleteRatio: 0, totalEdits: 0, totalFilesModified: 0, activeDaysWithEdits: 0 } };
function reply(body: unknown, ok = true) { return { ok, status: ok ? 200 : 502, statusText: ok ? 'OK' : 'Bad Gateway', json: async () => body }; }

afterEach(() => vi.unstubAllGlobals());

describe('DeepSeek completeness metadata', () => {
  it('keeps explicit pricing aliases and unknown prices through model, date and project merges', () => {
    const merged = mergeDailyResponses([daily(true), daily(false)]);
    expect(merged.totals.totalTokens).toBe(76);
    expect(merged.totals.totalCost).toBeCloseTo(0.2);
    expect(merged.totals.costAvailable).toBe(false);
    expect(merged.daily[0].costAvailable).toBe(false);
    expect(merged.daily[0].modelBreakdowns[0].costAvailable).toBe(false);
    expect(mergeDailyResponses([daily(true)]).daily[0].modelBreakdowns[0].costAvailable).toBe(true);
    expect(mergeProjects([{ projects: { '/work/a': [day(true)] } }, { projects: { '/work/a': [day(false)] } }]).projects.a[0].costAvailable).toBe(false);
  });

  it('preserves legacy absence and diagnostics without adding boolean values into numeric totals', () => {
    const merged = mergeDailyResponses([daily(), { daily: [], sourceErrors: [{ agent: 'deepseek', message: 'zstd unavailable' }] }]);
    expect(merged.totals.totalTokens).toBe(38);
    expect(merged.totals.costAvailable).toBe(false);
    expect(merged.sourceErrors).toEqual([{ agent: 'deepseek', message: 'zstd unavailable' }]);
    expect(mergeDailyResponses([daily()]).totals.costAvailable).toBeUndefined();
  });
});

describe('source failure isolation', () => {
  it('retains the healthy source for all four aggregate endpoints and exposes an actionable failed-source diagnostic', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input, 'http://localhost');
      if (url.pathname === '/api/agents') return reply({ available: ['claude', 'deepseek'], default: 'claude' });
      if (url.searchParams.get('agent') === 'deepseek') return reply({ hint: 'Install zstd to read compressed Harness sessions' }, false);
      if (url.pathname === '/api/daily') return reply(daily());
      if (url.pathname === '/api/projects') return reply({ projects: { '/work/a': [day()] } });
      if (url.pathname === '/api/blocks') return reply({ blocks: [block] });
      return reply(analytics);
    }));
    const [days, projects, blocks, tools] = await Promise.all([fetchDaily('all'), fetchProjects('all'), fetchBlocks('all'), fetchAnalytics('all')]);
    expect(days.totals.totalTokens).toBe(38);
    expect(days.totals.costAvailable).toBe(false);
    expect(Object.keys(projects.projects)).toEqual(['a']);
    expect(blocks.blocks[0]).toMatchObject({ id: 'claude:0:one', totalTokens: 38, costAvailable: false });
    expect(tools.toolUsageDistribution).toEqual([{ name: 'bash', count: 1 }]);
    for (const data of [days, projects, blocks, tools]) expect(data.sourceErrors?.[0]).toMatchObject({ agent: 'deepseek', message: expect.stringContaining('Install zstd') });
  });

  it('does not turn total source failure into successful zero usage', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string) => input === '/api/agents' ? reply({ available: ['deepseek'] }) : reply({ hint: 'Corrupt frame' }, false)));
    for (const load of [fetchDaily, fetchProjects, fetchBlocks, fetchAnalytics]) await expect(load('all')).rejects.toThrow('Corrupt frame');
    await expect(fetchDaily('deepseek')).rejects.toThrow('Corrupt frame');
  });

  it('drops an entire source if one project block request fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input, 'http://localhost');
      const source = url.searchParams.get('agent') || 'claude';
      if (url.pathname === '/api/agents') return reply({ available: ['claude', 'deepseek'] });
      if (url.pathname === '/api/projects') return reply({ projects: source === 'deepseek' ? { '/one/shared': [], '/two/shared': [] } : { '/healthy/shared': [] } });
      if (source === 'deepseek' && url.searchParams.get('project') === '/two/shared') return reply({ hint: 'bad project' }, false);
      return reply({ blocks: [block] });
    }));
    const result = await fetchBlocks('all', 'shared');
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].id).toBe('claude:0:one');
    expect(result.sourceErrors?.[0].agent).toBe('deepseek');
  });
});
