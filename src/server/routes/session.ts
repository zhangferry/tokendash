import { type Request, type Response } from 'express';
import { cache } from '../cache.js';
import { validateDaily } from '../../shared/schemas.js';
import { getDailyResponse as getClaudeDailyResponse } from '../claudeJsonlParser.js';
import { getDailyResponse as getCodexDailyResponse } from '../codexParser.js';
import { getDailyResponse as getOpenClawDailyResponse } from '../openclawParser.js';

export async function getSession(req: Request, res: Response): Promise<void> {
  const agent = req.query.agent as string || 'claude';
  const cacheKey = `session:${agent}`;
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

    // Session data uses same daily aggregation
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
    console.error('Error fetching session data:', error);
    res.status(502).json({
      error: 'Failed to fetch session data',
      hint: message,
    });
  }
}
