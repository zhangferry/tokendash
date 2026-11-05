import type { BlocksResponse, DailyResponse } from '../shared/types.js';
import type { QuotaCredentialValidation, QuotaProviderId, QuotaResponse } from '../server/quota/types.js';

/** Block granularities the daemon serves; the popover uses the shared 5m base plus 1m for the realtime tab. */
export type BlockGranularity = '1m' | '5m';

const BASE = '/api';

async function getJson<T>(path: string, params?: Record<string, string>): Promise<T> {
  const query = new URLSearchParams(params ?? {}).toString();
  const response = await fetch(`${BASE}${path}${query ? `?${query}` : ''}`);
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try { const body = await response.json(); detail = body.hint || body.error || detail; } catch { /* Non-JSON proxy error. */ }
    throw new Error(detail);
  }
  return (await response.json()) as T;
}

export async function getAgents(): Promise<string[]> {
  const data = await getJson<{ available: string[] }>('/agents');
  return data.available;
}

export async function getDaily(agent: string, refresh: boolean): Promise<DailyResponse> {
  return getJson<DailyResponse>('/daily', { agent, ...(refresh ? { refresh: '1' } : {}) });
}

export async function getBlocks(
  agent: string,
  granularity: BlockGranularity,
  refresh: boolean,
): Promise<BlocksResponse> {
  return getJson<BlocksResponse>('/blocks', {
    agent,
    granularity,
    ...(refresh ? { refresh: '1' } : {}),
  });
}

export async function getQuota(refresh: boolean): Promise<QuotaResponse> {
  return getJson<QuotaResponse>('/quota', refresh ? { refresh: '1' } : undefined);
}

export async function validateCredential(
  provider: QuotaProviderId,
  apiKey: string,
  baseUrl?: string,
): Promise<QuotaCredentialValidation> {
  const response = await fetch(`${BASE}/quota/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, apiKey, ...(baseUrl ? { baseUrl } : {}) }),
  });
  if (response.status !== 200 && response.status !== 422) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return (await response.json()) as QuotaCredentialValidation;
}

/** Provider ids whose credentials the panel can edit; Claude and Codex use their own CLI auth. */
export const EDITABLE_PROVIDERS: Array<{ id: QuotaProviderId; name: string; hint: string }> = [
  { id: 'glm', name: 'GLM Coding Plan', hint: 'Zhipu / Z.ai plan token' },
  { id: 'kimi', name: 'Kimi Code', hint: 'Kimi access token' },
  { id: 'minimax', name: 'MiniMax Coding Plan', hint: 'Subscription Key (sk-)' },
];