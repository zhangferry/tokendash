import { type Request, type Response } from 'express';
import { runCcusage } from '../ccusage.js';
import { cache } from '../cache.js';
import { validateBlocks } from '../../shared/schemas.js';
import { getBlocksResponse } from '../codexParser.js';
import { getClaudeBlocksByProject } from '../claudeBlocksParser.js';

export async function getBlocks(req: Request, res: Response): Promise<void> {
  const agent = req.query.agent as string || 'claude';
  const project = req.query.project as string || undefined;
  try {
    if (agent === 'codex') {
      const projectCacheKey = `blocks:${agent}:${project || 'all'}`;
      const cached = cache.get(projectCacheKey);
      if (cached) {
        res.json(cached);
        return;
      }

      const data = getBlocksResponse({ project: project || null });
      cache.set(projectCacheKey, data);
      res.json(data);
      return;
    }

    // Claude Code with project filter: use custom JSONL parser
    if (project) {
      const projectCacheKey = `blocks:claude:${project}`;
      const cached = cache.get(projectCacheKey);
      if (cached) {
        res.json(cached);
        return;
      }

      const blocks = getClaudeBlocksByProject(project);
      const data = { blocks };
      cache.set(projectCacheKey, data);
      res.json(data);
      return;
    }

    // Claude Code without project filter: use ccusage blocks
    const cacheKey = `blocks:${agent}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      res.json(cached);
      return;
    }

    const stdout = await runCcusage(['blocks']);
    const data = JSON.parse(stdout);
    const validated = validateBlocks(data);

    cache.set(cacheKey, validated);
    res.json(validated);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('Error fetching blocks data:', error);
    res.status(502).json({
      error: 'Failed to fetch blocks data from ccusage',
      hint: message,
    });
  }
}
