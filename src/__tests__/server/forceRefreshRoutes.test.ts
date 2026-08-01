import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const mocks = vi.hoisted(() => ({
  piDaily: vi.fn(() => ({ daily: [], totals: { inputTokens: 1, outputTokens: 2, cacheCreationTokens: 3, cacheReadTokens: 4, totalTokens: 10, totalCost: 0.5 } })),
  piProjects: vi.fn(() => ({ projects: {} })),
  piBlocks: vi.fn(() => ({ blocks: [] })),
  claudeToolCalls: vi.fn(() => []),
  computeAnalytics: vi.fn(() => ({
    codeChangeTrend: [],
    toolUsageDistribution: [],
    productivityKPIs: { avgLinesPerEdit: 0, filesModifiedPerDay: 0, addDeleteRatio: 0, totalEdits: 0, totalFilesModified: 0, activeDaysWithEdits: 0 },
    toolCallTrend: [],
  })),
}));

vi.mock('../../server/piParser.js', () => ({
  getDailyResponse: mocks.piDaily,
  getProjectsResponse: mocks.piProjects,
  getBlocksResponse: mocks.piBlocks,
}));
vi.mock('../../server/codexParser.js', () => ({ getDailyResponse: vi.fn(), getProjectsResponse: vi.fn(), getBlocksResponse: vi.fn() }));
vi.mock('../../server/openclawParser.js', () => ({ getDailyResponse: vi.fn(), getProjectsResponse: vi.fn(), getBlocksResponse: vi.fn() }));
vi.mock('../../server/opencodeParser.js', () => ({ getDailyResponse: vi.fn(), getProjectsResponse: vi.fn(), getBlocksResponse: vi.fn() }));
vi.mock('../../server/claudeJsonlParser.js', () => ({ getDailyResponse: vi.fn(), getProjectsResponse: vi.fn(), getBlocksResponse: vi.fn() }));
vi.mock('../../server/analyticsParser.js', () => ({
  extractClaudeToolCalls: mocks.claudeToolCalls,
  extractOpenClawToolCalls: vi.fn(),
  computeAnalytics: mocks.computeAnalytics,
}));

const { cache } = await import('../../server/cache.js');
const { getDaily } = await import('../../server/routes/daily.js');
const { getProjects } = await import('../../server/routes/projects.js');
const { getBlocks } = await import('../../server/routes/blocks.js');
const { getAnalytics } = await import('../../server/routes/analytics.js');

function request(agent: string): Request {
  return { query: { agent, refresh: '1' } } as unknown as Request;
}

function response() {
  const res = { json: vi.fn(), status: vi.fn() };
  res.status.mockReturnValue(res);
  return res as unknown as Response & { json: ReturnType<typeof vi.fn> };
}

describe('forced dashboard refreshes', () => {
  beforeEach(() => {
    cache.clear();
    vi.clearAllMocks();
  });

  it('recomputes daily, projects, and blocks instead of serving their fresh cache entries', async () => {
    cache.set('daily:pi', { cached: true });
    cache.set('projects:pi', { cached: true });
    cache.set('blocks:pi:all', { cached: true });
    const dailyRes = response();
    const projectsRes = response();
    const blocksRes = response();

    await getDaily(request('pi'), dailyRes);
    await getProjects(request('pi'), projectsRes);
    await getBlocks(request('pi'), blocksRes);

    expect(mocks.piDaily).toHaveBeenCalledOnce();
    expect(mocks.piProjects).toHaveBeenCalledOnce();
    expect(mocks.piBlocks).toHaveBeenCalledOnce();
    expect(dailyRes.json).toHaveBeenCalledWith(expect.objectContaining({ totals: expect.any(Object) }));
    expect(projectsRes.json).toHaveBeenCalledWith({ projects: {} });
    expect(blocksRes.json).toHaveBeenCalledWith({ blocks: [] });
  });

  it('recomputes analytics instead of serving its fresh cache entry', async () => {
    cache.set('analytics:claude:all', { cached: true });
    const analyticsRes = response();

    await getAnalytics(request('claude'), analyticsRes);

    expect(mocks.claudeToolCalls).toHaveBeenCalledOnce();
    expect(mocks.computeAnalytics).toHaveBeenCalledOnce();
    expect(analyticsRes.json).toHaveBeenCalledWith(expect.objectContaining({ productivityKPIs: expect.any(Object) }));
  });
});
