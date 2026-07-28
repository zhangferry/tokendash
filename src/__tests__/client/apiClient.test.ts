import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAnalytics, fetchBlocks, fetchDaily, fetchProjects } from '../../client/api/client.js';

describe('dashboard refresh requests', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('bypasses the server cache for every dashboard data source', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);

    await Promise.all([
      fetchDaily('pi', true),
      fetchProjects('pi', true),
      fetchBlocks('pi', 'D:\\work\\api', true),
      fetchAnalytics('pi', 'D:\\work\\api', true),
    ]);

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/daily?agent=pi&refresh=1');
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/projects?agent=pi&refresh=1');
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/blocks?agent=pi&project=D%3A%5Cwork%5Capi&refresh=1');
    expect(fetchMock).toHaveBeenNthCalledWith(4, '/api/analytics?agent=pi&project=D%3A%5Cwork%5Capi&refresh=1');
  });
});
