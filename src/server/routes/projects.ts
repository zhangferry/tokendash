import { type Request, type Response } from 'express';
import { cache } from '../cache.js';
import { validateProjects } from '../../shared/schemas.js';
import { getProjectsResponse as getCodexProjectsResponse } from '../codexParser.js';
import { getProjectsResponse as getOpenClawProjectsResponse } from '../openclawParser.js';
import { getProjectsResponse as getClaudeProjectsResponse } from '../claudeJsonlParser.js';

export async function getProjects(req: Request, res: Response): Promise<void> {
  const agent = req.query.agent as string || 'claude';
  const cacheKey = `projects:${agent}`;
  try {
    const cached = cache.get(cacheKey);
    if (cached) {
      res.json(cached);
      return;
    }

    // Stale-while-revalidate
    const stale = cache.getStale(cacheKey);
    if (stale) {
      refreshProjectsCache(agent, cacheKey);
      res.json(stale);
      return;
    }

    const data = fetchProjectsData(agent);
    cache.set(cacheKey, data);
    res.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('Error fetching projects data:', error);
    res.status(502).json({
      error: `Failed to fetch projects data from ${agent}`,
      hint: message,
    });
  }
}

function fetchProjectsData(agent: string) {
  if (agent === 'codex') {
    return getCodexProjectsResponse();
  } else if (agent === 'openclaw') {
    return validateProjects(getOpenClawProjectsResponse());
  } else {
    // Claude Code: parse JSONL directly (fast, no CLI)
    return validateProjects(getClaudeProjectsResponse());
  }
}

function refreshProjectsCache(agent: string, cacheKey: string): void {
  Promise.resolve()
    .then(() => { const data = fetchProjectsData(agent); cache.set(cacheKey, data); })
    .catch(err => console.error('Background refresh failed (projects):', err));
}
