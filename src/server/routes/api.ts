import { type Router, type Request, type Response } from 'express';
import { getDaily } from './daily.js';
import { getMonthly } from './monthly.js';
import { getSession } from './session.js';
import { getProjects } from './projects.js';
import { getBlocks } from './blocks.js';
import { detectAvailableAgents } from '../ccusage.js';

async function getAgents(_req: Request, res: Response): Promise<void> {
  try {
    const agents = await detectAvailableAgents();
    const available: string[] = [];
    if (agents.claude) available.push('claude');
    if (agents.codex) available.push('codex');
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
}
