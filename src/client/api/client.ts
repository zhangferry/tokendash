import { projectName } from '../../shared/projectNames.js';
import type { DailyResponse, MonthlyResponse, SessionResponse, ProjectsResponse, BlocksResponse, AnalyticsResponse, AppSettingsResponse, SessionAnalyticsResponse, SessionDetail } from '../../shared/types.js';
import { mergeDailyResponses, mergeAnalytics, mergeProjects } from '../utils/agentAggregation.js';

const BASE = '/api';

export interface AgentsResponse {
  available: string[];
  default: string | null;
}


async function responseError(response: Response, label: string): Promise<Error> {
  let detail = `${response.status} ${response.statusText}`;
  try {
    const body = await response.json();
    detail = body.hint || body.error || detail;
  } catch { /* A proxy may return a non-JSON error response. */ }
  return new Error(`${label}: ${detail}`);
}

export async function fetchSettings(): Promise<AppSettingsResponse> {
  const res = await fetch(`${BASE}/settings`);
  if (!res.ok) {
    throw new Error(`Failed to fetch settings: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export async function updateCodexDataPaths(paths: string[]): Promise<AppSettingsResponse> {
  const res = await fetch(`${BASE}/settings/codex-data-paths`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths }),
  });
  if (!res.ok) {
    throw new Error(`Failed to update Codex data paths: ${res.status} ${res.statusText}`);
  }
  return res.json();
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

/** Settle a complete source independently so one unavailable agent cannot erase healthy data. */
async function collectSources<T>(sources: string[], fetchSource: (source: string) => Promise<T>) {
  const settled = await Promise.allSettled(sources.map(fetchSource));
  const values: T[] = [];
  const sourceErrors: Array<{ agent: string; message: string }> = [];
  for (const [index, result] of settled.entries()) {
    if (result.status === 'fulfilled') values.push(result.value);
    else sourceErrors.push({ agent: sources[index], message: result.reason instanceof Error ? result.reason.message : String(result.reason) });
  }
  if (sources.length > 0 && values.length === 0) {
    throw new Error(sourceErrors.map(error => `${error.agent}: ${error.message}`).join('; '));
  }
  return { values, sourceErrors };
}

export async function fetchDaily(agent = 'claude', refresh = false): Promise<DailyResponse> {
  if (agent === 'all') {
    const { available } = await fetchAgents();
    const { values, sourceErrors } = await collectSources(available, source => fetchDaily(source, refresh));
    return mergeDailyResponses([...values, { daily: [], sourceErrors }]);
  }
  const res = await fetch(`${BASE}/daily${qs(agent, refresh ? { refresh: '1' } : undefined)}`);
  if (!res.ok) {
    throw await responseError(res, 'Failed to fetch daily data');
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

export async function fetchProjects(agent = 'claude', refresh = false): Promise<ProjectsResponse> {
  if (agent === 'all') {
    const { available } = await fetchAgents();
    const { values, sourceErrors } = await collectSources(available, source => fetchProjects(source, refresh));
    return mergeProjects([...values, { projects: {}, sourceErrors }]);
  }
  const res = await fetch(`${BASE}/projects${qs(agent, refresh ? { refresh: '1' } : undefined)}`);
  if (!res.ok) {
    throw await responseError(res, 'Failed to fetch projects data');
  }
  return res.json();
}

export async function fetchBlocks(agent = 'claude', project = '', refresh = false): Promise<BlocksResponse> {
  if (agent === 'all') {
    const sources = (await fetchAgents()).available;
    const { values, sourceErrors } = await collectSources(sources, async source => {
      const projects = project ? Object.keys((await fetchProjects(source, refresh)).projects).filter(name => projectName(name) === project) : [''];
      const responses = await Promise.all(projects.map(name => fetchBlocks(source, name, refresh)));
      return { blocks: responses.flatMap((response, index) => response.blocks.map(block => ({ ...block, id: source + ':' + index + ':' + block.id }))), sourceErrors: responses.flatMap(response => response.sourceErrors ?? []) };
    });
    const errors = [...sourceErrors, ...values.flatMap(response => response.sourceErrors)];
    return { blocks: values.flatMap(response => response.blocks).sort((a, b) => a.startTime.localeCompare(b.startTime)), ...(errors.length ? { sourceErrors: errors } : {}) };
  }
  const res = await fetch(`${BASE}/blocks${qs(agent, { ...(project ? { project } : {}), ...(refresh ? { refresh: '1' } : {}) })}`);
  if (!res.ok) {
    throw await responseError(res, 'Failed to fetch blocks data');
  }
  return res.json();
}

export async function fetchAnalytics(agent = 'claude', project = '', refresh = false): Promise<AnalyticsResponse> {
  if (agent === 'all') {
    const sources = (await fetchAgents()).available;
    const { values, sourceErrors } = await collectSources(sources.filter(source => source !== 'codex'), async source => {
      const projects = project ? Object.keys((await fetchProjects(source, refresh)).projects).filter(name => projectName(name) === project) : [''];
      return Promise.all(projects.map(name => fetchAnalytics(source, name, refresh)));
    });
    const merged = mergeAnalytics(values.flat());
    return { ...merged, ...(sourceErrors.length ? { sourceErrors: [...(merged.sourceErrors ?? []), ...sourceErrors] } : {}) };
  }
  const res = await fetch(`${BASE}/analytics${qs(agent, { ...(project ? { project } : {}), ...(refresh ? { refresh: '1' } : {}) })}`);
  if (!res.ok) {
    throw await responseError(res, 'Failed to fetch analytics');
  }
  return res.json();
}

export interface SessionAnalyticsRequest {
  agent: string;
  project?: string;
  range: string;
  model?: string;
  status?: string;
  query?: string;
  cursor?: string;
  limit?: number;
  refresh?: boolean;
  signal?: AbortSignal;
}

export async function fetchSessionAnalytics(request: SessionAnalyticsRequest): Promise<SessionAnalyticsResponse> {
  const params: Record<string, string> = {
    agent: request.agent,
    range: request.range,
    ...(request.project ? { project: request.project } : {}),
    ...(request.model ? { model: request.model } : {}),
    ...(request.status ? { status: request.status } : {}),
    ...(request.query ? { query: request.query } : {}),
    ...(request.cursor ? { cursor: request.cursor } : {}),
    ...(request.limit ? { limit: String(request.limit) } : {}),
    ...(request.refresh ? { refresh: '1' } : {}),
  };
  const res = await fetch(`${BASE}/session-analytics?${new URLSearchParams(params)}`, { signal: request.signal });
  if (!res.ok) throw new Error(`Failed to fetch session analytics: ${res.status} ${res.statusText}`);
  return res.json();
}

export async function fetchSessionDetail(agent: string, id: string, includeContent = false): Promise<SessionDetail> {
  const params = new URLSearchParams({ agent, ...(includeContent ? { include: 'content' } : {}) });
  const res = await fetch(`${BASE}/sessions/${encodeURIComponent(id)}?${params}`);
  if (!res.ok) throw new Error(`Failed to fetch session detail: ${res.status} ${res.statusText}`);
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    throw new Error('Session detail service returned an unexpected response. Start the current TokenDash development server and retry.');
  }
  return res.json();
}

export async function updateBillingExchangeRate(exchangeRate: number): Promise<AppSettingsResponse> {
  const response = await fetch(BASE + '/settings/billing', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ exchangeRate }) });
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('The exchange-rate endpoint is unavailable. Start the current version of the TokenDash server.');
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Failed to save the exchange rate');
  return data;
}
