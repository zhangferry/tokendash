import { type Request, type Response } from 'express';
import { cache } from '../cache.js';
import { validateAnalytics } from '../../shared/schemas.js';
import { extractClaudeToolCalls, extractOpenClawToolCalls, computeAnalytics } from '../analyticsParser.js';

const EMPTY_ANALYTICS = {
  codeChangeTrend: [],
  toolUsageDistribution: [],
  productivityKPIs: { avgLinesPerEdit: 0, filesModifiedPerDay: 0, addDeleteRatio: 0, totalEdits: 0, totalFilesModified: 0, activeDaysWithEdits: 0 },
  toolCallTrend: [],
};

export async function getAnalytics(req: Request, res: Response): Promise<void> {
  const agent = req.query.agent as string || 'claude';
  const project = req.query.project as string || undefined;

  if (agent === 'codex' || agent === 'opencode') {
    res.json(EMPTY_ANALYTICS);
    return;
  }

  try {
    const cacheKey = `analytics:${agent}:${project || 'all'}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      res.json(cached);
      return;
    }

    const toolCalls = agent === 'openclaw'
      ? extractOpenClawToolCalls(project || null)
      : extractClaudeToolCalls(project || null);

    const data = computeAnalytics(toolCalls);
    const validated = validateAnalytics(data);
    cache.set(cacheKey, validated);
    res.json(validated);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('Error fetching analytics:', error);
    res.status(502).json({
      error: `Failed to fetch analytics from ${agent}`,
      hint: message,
    });
  }
}
