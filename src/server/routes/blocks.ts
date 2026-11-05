import { type Request, type Response } from 'express';
import { cache } from '../cache.js';
import { validateBlocks } from '../../shared/schemas.js';
import { type BlockGranularity } from '../claudeJsonlParser.js';
import { getCodexBlocksResponse } from '../codexResponseService.js';
import { getBlocksResponse as getOpenClawBlocksResponse } from '../openclawParser.js';
import { getBlocksResponse as getOpencodeBlocksResponse } from '../opencodeParser.js';
import { getBlocksResponse as getClaudeBlocksResponse } from '../claudeJsonlParser.js';
import { getBlocksResponse as getPiBlocksResponse } from '../piParser.js';
import { getBlocksResponse as getDeepseekBlocksResponse } from '../deepseekParser.js';

function parseGranularity(raw: unknown): BlockGranularity {
  return raw === '15m' || raw === '5m' || raw === '1m' ? raw : 'hour';   // invalid values fall back to hour
}

/// Realtime buckets go stale in a minute, so the 1m key re-scans at most once
/// per minute instead of sitting out the default 5-minute TTL.
const GRANULARITY_TTL_MS: Record<BlockGranularity, number> = {
  hour: 5 * 60_000, '15m': 5 * 60_000, '5m': 5 * 60_000, '1m': 60_000,
};

export async function getBlocks(req: Request, res: Response): Promise<void> {
  const agent = req.query.agent as string || 'claude';
  const project = req.query.project as string || undefined;
  const force = req.query.refresh === '1' || req.query.refresh === 'true';
  const granularity = parseGranularity(req.query.granularity);

  try {
    const cacheKey = `blocks:${agent}:${project || 'all'}${granularity !== 'hour' ? `:${granularity}` : ''}`;
    if (!force) {
      const cached = cache.get(cacheKey);
      if (cached) {
        res.json(cached);
        return;
      }

      // Stale-while-revalidate
      const stale = cache.getStale(cacheKey);
      if (stale) {
        refreshBlocksCache(agent, project, cacheKey, granularity);
        res.json(stale);
        return;
      }
    }

    const data = await fetchBlocksData(agent, project, granularity);
    cache.set(cacheKey, data, GRANULARITY_TTL_MS[granularity]);
    res.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('Error fetching blocks data:', error);
    res.status(502).json({
      error: 'Failed to fetch blocks data',
      hint: message,
    });
  }
}

async function fetchBlocksData(agent: string, project: string | undefined, granularity: BlockGranularity) {
  if (agent === 'openclaw') {
    return validateBlocks(getOpenClawBlocksResponse({ project: project || null, granularity }));
  } else if (agent === 'opencode') {
    return validateBlocks(getOpencodeBlocksResponse({ project: project || null, granularity }));
  } else if (agent === 'codex') {
    return validateBlocks(await getCodexBlocksResponse({ project: project || null, granularity }));
  } else if (agent === 'deepseek') {
    return validateBlocks(getDeepseekBlocksResponse({ project: project || null, granularity }));
  } else if (agent === 'pi') {
    return validateBlocks(getPiBlocksResponse({ project: project || null, granularity }));
  } else {
    // Claude Code: parse JSONL directly (fast, no CLI)
    return validateBlocks(getClaudeBlocksResponse(project || null, undefined, granularity));
  }
}

function refreshBlocksCache(
  agent: string,
  project: string | undefined,
  cacheKey: string,
  granularity: BlockGranularity,
): void {
  Promise.resolve()
    .then(async () => { const data = await fetchBlocksData(agent, project, granularity); cache.set(cacheKey, data, GRANULARITY_TTL_MS[granularity]); })
    .catch(err => console.error('Background refresh failed (blocks):', err));
}
