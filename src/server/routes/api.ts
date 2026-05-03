import { type Router, type Request, type Response } from 'express';
import { getDaily } from './daily.js';
import { getMonthly } from './monthly.js';
import { getSession } from './session.js';
import { getProjects } from './projects.js';
import { getBlocks } from './blocks.js';
import { getAnalytics } from './analytics.js';
import { detectAvailableAgents } from '../agentDetection.js';
import { isOpenClawAccessible } from '../openclawParser.js';
import { isOpencodeAccessible } from '../opencodeParser.js';

function getAgents(_req: Request, res: Response): void {
  try {
    const agents = detectAvailableAgents();
    const available: string[] = [];
    if (agents.claude) available.push('claude');
    if (agents.codex) available.push('codex');
    if (isOpenClawAccessible()) available.push('openclaw');
    if (isOpencodeAccessible()) available.push('opencode');
    res.json({ available, default: available[0] || null });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: 'Failed to detect agents', hint: message });
  }
}

export function registerApiRoutes(router: Router): void {
  router.get('/agents', getAgents);
  router.get('/daily', getDaily);
  router.get('/monthly', getMonthly);
  router.get('/session', getSession);
  router.get('/projects', getProjects);
  router.get('/blocks', getBlocks);
  router.get('/analytics', getAnalytics);
}
