import { type Request, type Response } from 'express';
import { cache } from '../cache.js';
import { validateDaily } from '../../shared/schemas.js';
import { getDailyResponse as getCodexDailyResponse } from '../codexParser.js';
import { getDailyResponse as getOpenClawDailyResponse } from '../openclawParser.js';
import { getDailyResponse as getOpencodeDailyResponse } from '../opencodeParser.js';
import { getDailyResponse as getClaudeDailyResponse } from '../claudeJsonlParser.js';

export async function getDaily(req: Request, res: Response): Promise<void> {
  const agent = req.query.agent as string || 'claude';
  const cacheKey = `daily:${agent}`;
  try {
    const cached = cache.get(cacheKey);
    if (cached) {
      res.json(cached);
      return;
    }

    // Stale-while-revalidate: return stale data, refresh in background
    const stale = cache.getStale(cacheKey);
    if (stale) {
      refreshDailyCache(agent, cacheKey);
      res.json(stale);
      return;
    }

    const data = await fetchDailyData(agent);
    cache.set(cacheKey, data);
    res.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('Error fetching daily data:', error);
    res.status(502).json({
      error: `Failed to fetch daily data from ${agent}`,
      hint: message,
    });
  }
}

function fetchDailyData(agent: string) {
  if (agent === 'codex') {
    return Promise.resolve(getCodexDailyResponse());
  } else if (agent === 'openclaw') {
    return Promise.resolve(validateDaily(getOpenClawDailyResponse()));
  } else if (agent === 'opencode') {
    return Promise.resolve(validateDaily(getOpencodeDailyResponse()));
  } else {
    // Claude Code: parse JSONL directly (fast, no CLI)
    return Promise.resolve(validateDaily(getClaudeDailyResponse()));
  }
}

function refreshDailyCache(agent: string, cacheKey: string): void {
  fetchDailyData(agent)
    .then(data => cache.set(cacheKey, data))
    .catch(err => console.error('Background refresh failed (daily):', err));
}
