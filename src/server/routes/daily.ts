import { type Request, type Response } from 'express';
import { runCcusage } from '../ccusage.js';
import { cache } from '../cache.js';
import { validateDaily } from '../../shared/schemas.js';
import { getDailyResponse } from '../codexParser.js';
import { getDailyResponse as getOpenClawDailyResponse } from '../openclawParser.js';

export async function getDaily(req: Request, res: Response): Promise<void> {
  const agent = req.query.agent as string || 'claude';
  const cacheKey = `daily:${agent}`;
  try {
    const cached = cache.get(cacheKey);
    if (cached) {
      res.json(cached);
      return;
    }

    if (agent === 'codex') {
      const data = getDailyResponse();
      cache.set(cacheKey, data);
      res.json(data);
    } else if (agent === 'openclaw') {
      const data = getOpenClawDailyResponse();
      const validated = validateDaily(data);
      cache.set(cacheKey, validated);
      res.json(validated);
    } else {
      const stdout = await runCcusage(['daily', '--breakdown']);
      const data = JSON.parse(stdout);
      const validated = validateDaily(data);
      cache.set(cacheKey, validated);
      res.json(validated);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('Error fetching daily data:', error);
    res.status(502).json({
      error: `Failed to fetch daily data from ${agent}`,
      hint: message,
    });
  }
}
