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

export interface AppInfo {
  packageName: string;
  version: string;
  dashboardUrl?: string;
}

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

function getAppInfo(info: AppInfo): (_req: Request, res: Response) => void {
  return (req: Request, res: Response) => {
    const host = req.get('host');
    res.json({
      ...info,
      dashboardUrl: host ? `${req.protocol}://${host}` : info.dashboardUrl,
    });
  };
}

export function registerApiRoutes(router: Router, appInfo: AppInfo): void {
  router.get('/app-info', getAppInfo(appInfo));
  router.get('/agents', getAgents);
  router.get('/daily', getDaily);
  router.get('/monthly', getMonthly);
  router.get('/session', getSession);
  router.get('/projects', getProjects);
  router.get('/blocks', getBlocks);
  router.get('/analytics', getAnalytics);
}
