import { type Request, type Response } from 'express';
import { cache } from '../cache.js';
import { validateProjects } from '../../shared/schemas.js';
import { getCodexProjectsResponse } from '../codexResponseService.js';
import { getProjectsResponse as getOpenClawProjectsResponse } from '../openclawParser.js';
import { getProjectsResponse as getOpencodeProjectsResponse } from '../opencodeParser.js';
import { getProjectsResponse as getClaudeProjectsResponse } from '../claudeJsonlParser.js';
import { getProjectsResponse as getPiProjectsResponse } from '../piParser.js';
import { getProjectsResponse as getDeepseekProjectsResponse } from '../deepseekParser.js';

export async function getProjects(req: Request, res: Response): Promise<void> {
  const agent = req.query.agent as string || 'claude';
  const force = req.query.refresh === '1' || req.query.refresh === 'true';
  const cacheKey = `projects:${agent}`;
  try {
    if (!force) {
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
    }

    const data = await fetchProjectsData(agent);
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

async function fetchProjectsData(agent: string) {
  if (agent === 'codex') {
    return getCodexProjectsResponse();
  } else if (agent === 'openclaw') {
    return validateProjects(getOpenClawProjectsResponse());
  } else if (agent === 'opencode') {
    return validateProjects(getOpencodeProjectsResponse());
  } else if (agent === 'deepseek') {
    return validateProjects(getDeepseekProjectsResponse());
  } else if (agent === 'pi') {
    return validateProjects(getPiProjectsResponse());
  } else {
    // Claude Code: parse JSONL directly (fast, no CLI)
    return validateProjects(getClaudeProjectsResponse());
  }
}

function refreshProjectsCache(agent: string, cacheKey: string): void {
  Promise.resolve()
    .then(async () => { const data = await fetchProjectsData(agent); cache.set(cacheKey, data); })
    .catch(err => console.error('Background refresh failed (projects):', err));
}
