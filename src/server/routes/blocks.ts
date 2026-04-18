import { type Request, type Response } from 'express';
import { cache } from '../cache.js';
import { validateBlocks } from '../../shared/schemas.js';
import { getBlocksResponse as getCodexBlocksResponse } from '../codexParser.js';
import { getBlocksResponse as getOpenClawBlocksResponse } from '../openclawParser.js';
import { getBlocksResponse as getClaudeBlocksResponse } from '../claudeJsonlParser.js';

export async function getBlocks(req: Request, res: Response): Promise<void> {
  const agent = req.query.agent as string || 'claude';
  const project = req.query.project as string || undefined;

  try {
    const cacheKey = `blocks:${agent}:${project || 'all'}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      res.json(cached);
      return;
    }

    // Stale-while-revalidate
    const stale = cache.getStale(cacheKey);
    if (stale) {
      refreshBlocksCache(agent, project, cacheKey);
      res.json(stale);
      return;
    }

    const data = fetchBlocksData(agent, project);
    cache.set(cacheKey, data);
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

function fetchBlocksData(agent: string, project?: string) {
  if (agent === 'openclaw') {
    return validateBlocks(getOpenClawBlocksResponse({ project: project || null }));
  } else if (agent === 'codex') {
    return validateBlocks(getCodexBlocksResponse({ project: project || null }));
  } else {
    // Claude Code: parse JSONL directly (fast, no CLI)
    return validateBlocks(getClaudeBlocksResponse(project || null));
  }
}

function refreshBlocksCache(agent: string, project: string | undefined, cacheKey: string): void {
  Promise.resolve()
    .then(() => { const data = fetchBlocksData(agent, project); cache.set(cacheKey, data); })
    .catch(err => console.error('Background refresh failed (blocks):', err));
}
