import type { DailyResponse, MonthlyResponse, SessionResponse, ProjectsResponse, BlocksResponse } from '../../shared/types.js';

const BASE = '/api';

export interface AgentsResponse {
  available: string[];
  default: string | null;
}

export async function fetchAgents(): Promise<AgentsResponse> {
  const res = await fetch(`${BASE}/agents`);
  if (!res.ok) {
    throw new Error(`Failed to fetch agents: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

function qs(agent: string, extra?: Record<string, string>): string {
  const parts: string[] = [];
  if (agent !== 'claude') parts.push(`agent=${agent}`);
  if (extra) {
    const keys = Object.keys(extra);
    for (let i = 0; i < keys.length; i++) {
      const val = extra[keys[i]];
      if (val) parts.push(encodeURIComponent(keys[i]) + '=' + encodeURIComponent(val));
    }
  }
  return parts.length > 0 ? '?' + parts.join('&') : '';
}

export async function fetchDaily(agent = 'claude'): Promise<DailyResponse> {
  const res = await fetch(`${BASE}/daily${qs(agent)}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch daily data: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export async function fetchMonthly(agent = 'claude'): Promise<MonthlyResponse> {
  const res = await fetch(`${BASE}/monthly${qs(agent)}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch monthly data: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export async function fetchSession(agent = 'claude'): Promise<SessionResponse> {
  const res = await fetch(`${BASE}/session${qs(agent)}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch session data: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export async function fetchProjects(agent = 'claude'): Promise<ProjectsResponse> {
  const res = await fetch(`${BASE}/projects${qs(agent)}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch projects data: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export async function fetchBlocks(agent = 'claude', project = ''): Promise<BlocksResponse> {
  const res = await fetch(`${BASE}/blocks${qs(agent, project ? { project } : undefined)}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch blocks data: ${res.status} ${res.statusText}`);
  }
  return res.json();
}
