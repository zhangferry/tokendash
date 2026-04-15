import { type Request, type Response } from 'express';
import { runCcusage } from '../ccusage.js';
import { cache } from '../cache.js';
import { validateProjects } from '../../shared/schemas.js';
import { getProjectsResponse } from '../codexParser.js';
import { getProjectsResponse as getOpenClawProjectsResponse } from '../openclawParser.js';

export async function getProjects(req: Request, res: Response): Promise<void> {
  const agent = req.query.agent as string || 'claude';
  const cacheKey = `projects:${agent}`;
  try {
    const cached = cache.get(cacheKey);
    if (cached) {
      res.json(cached);
      return;
    }

    if (agent === 'codex') {
      const data = getProjectsResponse();
      cache.set(cacheKey, data);
      res.json(data);
    } else if (agent === 'openclaw') {
      const data = getOpenClawProjectsResponse();
      const validated = validateProjects(data);
      cache.set(cacheKey, validated);
      res.json(validated);
    } else {
      const stdout = await runCcusage(['daily', '--instances', '--breakdown']);
      const data = JSON.parse(stdout);
      const validated = validateProjects(data);
      cache.set(cacheKey, validated);
      res.json(validated);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('Error fetching projects data:', error);
    res.status(502).json({
      error: `Failed to fetch projects data from ${agent}`,
      hint: message,
    });
  }
}
