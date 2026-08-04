import { type Request, type Response } from 'express';
import { cache } from '../cache.js';
import { validateSessionAnalytics, validateSessionDetail } from '../../shared/schemas.js';
import {
  getSessionAnalytics,
  getSessionAnalyticsSourceRevision,
  getSessionDetail,
  invalidateSessionAnalyticsSource,
  type SessionAnalyticsFilters,
  type SessionAnalyticsRange,
} from '../sessionAnalyticsParser.js';
import type { SessionStatus } from '../../shared/types.js';

const RANGES = new Set<SessionAnalyticsRange>(['today', '7d', '30d', '60d', 'all']);
const STATUSES = new Set<SessionStatus>(['active', 'complete', 'interrupted', 'unknown']);

function queryValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function parseLimit(value: unknown): number | undefined {
  const text = queryValue(value);
  if (!text) return undefined;
  const parsed = Number(text);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 100) : undefined;
}

function parseFilters(req: Request, res: Response): SessionAnalyticsFilters | undefined {
  const range = queryValue(req.query.range) || 'all';
  const status = queryValue(req.query.status);
  if (!RANGES.has(range as SessionAnalyticsRange)) {
    res.status(400).json({ error: 'Invalid range', hint: 'Use today, 7d, 30d, 60d, or all.' });
    return undefined;
  }
  if (status && !STATUSES.has(status as SessionStatus)) {
    res.status(400).json({ error: 'Invalid status', hint: 'Use active, complete, interrupted, or unknown.' });
    return undefined;
  }
  return {
    project: queryValue(req.query.project),
    range: range as SessionAnalyticsRange,
    model: queryValue(req.query.model),
    status: status as SessionStatus | undefined,
    query: queryValue(req.query.query),
    cursor: queryValue(req.query.cursor),
    limit: parseLimit(req.query.limit),
  };
}

function cacheKey(agent: string, filters: SessionAnalyticsFilters, revision: string): string {
  // Revision is source metadata (path, mtime, and size) and not user content.
  return `session-analytics:${agent}:${filters.project || 'all'}:${filters.range || 'all'}:${filters.model || 'all'}:${filters.status || 'all'}:${filters.query || ''}:${filters.cursor || ''}:${filters.limit || 20}:${revision}`;
}

function fetchAnalytics(agent: string, filters: SessionAnalyticsFilters, revision: string) {
  return validateSessionAnalytics(getSessionAnalytics(agent, filters, revision));
}

function refreshAnalyticsCache(agent: string, filters: SessionAnalyticsFilters): void {
  Promise.resolve()
    .then(() => {
      const revision = getSessionAnalyticsSourceRevision(agent);
      cache.set(cacheKey(agent, filters, revision), fetchAnalytics(agent, filters, revision));
    })
    .catch(error => console.error('Background refresh failed (session analytics):', error));
}

export async function getSessionAnalyticsRoute(req: Request, res: Response): Promise<void> {
  const filters = parseFilters(req, res);
  if (!filters) return;
  const agent = queryValue(req.query.agent) || 'claude';
  const force = req.query.refresh === '1' || req.query.refresh === 'true';
  try {
    if (force) invalidateSessionAnalyticsSource(agent);
    const revision = getSessionAnalyticsSourceRevision(agent);
    const key = cacheKey(agent, filters, revision);
    if (!force) {
      const cached = cache.get(key);
      if (cached) {
        res.json(cached);
        return;
      }
      const stale = cache.getStale(key);
      if (stale) {
        refreshAnalyticsCache(agent, filters);
        res.json(stale);
        return;
      }
    }
    const data = fetchAnalytics(agent, filters, revision);
    cache.set(key, data);
    res.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('Error fetching session analytics:', error);
    res.status(502).json({ error: `Failed to fetch session analytics from ${agent}`, hint: message });
  }
}

export async function getSessionDetailRoute(req: Request, res: Response): Promise<void> {
  const agent = queryValue(req.query.agent) || 'claude';
  const id = typeof req.params.id === 'string' ? req.params.id : undefined;
  // ID is resolved exclusively through the server-owned metadata index. A path is never accepted.
  if (!id || id.length > 512) {
    res.status(400).json({ error: 'Invalid session ID' });
    return;
  }
  try {
    if (req.query.refresh === '1' || req.query.refresh === 'true') invalidateSessionAnalyticsSource(agent);
    const detail = getSessionDetail(agent, id, undefined, req.query.include === 'content');
    if (!detail) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json(validateSessionDetail(detail));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('Error fetching session detail:', error);
    res.status(502).json({ error: 'Failed to fetch session detail', hint: message });
  }
}
