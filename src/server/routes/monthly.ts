import { type Request, type Response } from 'express';
import { cache } from '../cache.js';
import { validateDaily } from '../../shared/schemas.js';
import { getDailyResponse as getClaudeDailyResponse } from '../claudeJsonlParser.js';
import { getDailyResponse as getCodexDailyResponse } from '../codexParser.js';
import { getDailyResponse as getOpenClawDailyResponse } from '../openclawParser.js';

export async function getMonthly(req: Request, res: Response): Promise<void> {
  const agent = req.query.agent as string || 'claude';
  const cacheKey = `monthly:${agent}`;
  try {
    const cached = cache.get(cacheKey);
    if (cached) {
      res.json(cached);
      return;
    }

    const stale = cache.getStale(cacheKey);
    if (stale) {
      res.json(stale);
      return;
    }

    // Monthly is same as daily for our parser (aggregated by date already)
    let data;
    if (agent === 'codex') {
      data = validateDaily(getCodexDailyResponse());
    } else if (agent === 'openclaw') {
      data = validateDaily(getOpenClawDailyResponse());
    } else {
      data = validateDaily(getClaudeDailyResponse());
    }

    cache.set(cacheKey, data);
    res.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('Error fetching monthly data:', error);
    res.status(502).json({
      error: 'Failed to fetch monthly data',
      hint: message,
    });
  }
}
