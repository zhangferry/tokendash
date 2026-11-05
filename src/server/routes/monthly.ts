import { type Request, type Response } from 'express';
import { cache } from '../cache.js';
import { validateDaily } from '../../shared/schemas.js';
import { getDailyResponse as getClaudeDailyResponse } from '../claudeJsonlParser.js';
import { getCodexDailyResponse } from '../codexResponseService.js';
import { getDailyResponse as getOpenClawDailyResponse } from '../openclawParser.js';
import { getDailyResponse as getDeepseekDailyResponse } from '../deepseekParser.js';

export async function getMonthly(req: Request, res: Response): Promise<void> {
  const agent = req.query.agent as string || 'claude';
  const cacheKey = `monthly:${agent}`;
  try {
    const force = req.query.refresh === '1' || req.query.refresh === 'true';
    const cached = force ? undefined : cache.get(cacheKey);
    if (cached) {
      res.json(cached);
      return;
    }

    const stale = force ? undefined : cache.getStale(cacheKey);
    if (stale) {
      res.json(stale);
      return;
    }

    // Monthly is same as daily for our parser (aggregated by date already)
    let data;
    if (agent === 'codex') {
      data = validateDaily(await getCodexDailyResponse());
    } else if (agent === 'deepseek') {
      data = validateDaily(getDeepseekDailyResponse());
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
