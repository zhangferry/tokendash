import type { QuotaSnapshot } from '../types.js';
import type { QuotaAdapter } from '../adapter.js';
import { QuotaError, baseSnapshot } from '../adapter.js';
import { fetchJsonWithTimeout, HttpError, classifyHttpError, windowFromCounts, unixToIso } from '../helpers.js';
import { readStoredCredential } from '../credentialsFile.js';
import type { QuotaCredentialInput } from '../types.js';

/**
 * MiniMax Coding Plan (Token Plan) adapter.
 *
 * Source: official `GET /v1/token_plan/remains`, Bearer auth with the
 * Subscription Key (sk-..., NOT the pay-as-you-go API key). Per-model buckets,
 * each with a 5-hour interval window and a weekly window.
 *
 * NAMING GOTCHA: despite the name, `current_interval_usage_count` /
 * `current_weekly_usage_count` return REMAINING units, not consumed. We invert
 * to derive used = total - usage_count.
 */

interface MinimaxModelRemain {
  model_name?: string;
  start_time?: number; // unix ms
  end_time?: number;   // unix ms
  remains_time?: number;
  current_interval_usage_count?: number;   // REMAINING (misnamed upstream)
  current_interval_total_count?: number;   // total
  current_weekly_usage_count?: number;     // REMAINING (misnamed upstream)
  current_weekly_total_count?: number;     // total
}

interface MinimaxRemainsResponse {
  model_remains?: MinimaxModelRemain[];
  base_resp?: { status_code?: number; status_msg?: string };
}

export const minimaxAdapter: QuotaAdapter = {
  provider: 'minimax',
  displayName: 'MiniMax Coding Plan',

  async isConfigured(): Promise<boolean> {
    return !!resolveCredential();
  },

  async fetch(options?: { credential?: QuotaCredentialInput }): Promise<QuotaSnapshot> {
    const cred = resolveCredential(options?.credential);
    if (!cred) {
      throw new QuotaError({ state: 'not_configured', message: 'set MINIMAX_API_KEY (Subscription Key)' });
    }

    let data: MinimaxRemainsResponse;
    try {
      data = (await fetchJsonWithTimeout(`${cred.base}/v1/token_plan/remains`, {
        headers: {
          Authorization: `Bearer ${cred.key}`,
          'Content-Type': 'application/json',
        },
      })) as MinimaxRemainsResponse;
    } catch (err) {
      throw classifyFetchError(err);
    }

    if (data.base_resp?.status_code && data.base_resp.status_code !== 0) {
      throw new QuotaError({
        state: 'upstream_unavailable',
        message: data.base_resp.status_msg || `MiniMax error ${data.base_resp.status_code}`,
      });
    }

    const windows = [];
    for (const m of data.model_remains ?? []) {
      const model = m.model_name ?? 'MiniMax';
      const intervalTotal = m.current_interval_total_count ?? 0;
      const intervalRemaining = m.current_interval_usage_count ?? 0;
      // used = total - remaining (the "*_usage_count" fields are misnamed).
      if (intervalTotal > 0) {
        windows.push(windowFromCounts(
          `minimax_5h_${model}`,
          `5-Hour · ${model}`,
          Math.max(0, intervalTotal - intervalRemaining),
          intervalTotal,
          { durationMins: 300, resetsAt: unixToIso(m.end_time) },
        ));
      }
      const weeklyTotal = m.current_weekly_total_count ?? 0;
      const weeklyRemaining = m.current_weekly_usage_count ?? 0;
      if (weeklyTotal > 0) {
        windows.push(windowFromCounts(
          `minimax_weekly_${model}`,
          `Weekly · ${model}`,
          Math.max(0, weeklyTotal - weeklyRemaining),
          weeklyTotal,
          { durationMins: 10080 },
        ));
      }
    }

    const snap = baseSnapshot('minimax', 'MiniMax Coding Plan', { windows });
    return { ...snap, status: { state: 'ok' } };
  },
};

function classifyFetchError(err: unknown): QuotaError {
  if (err instanceof HttpError) {
    const c = classifyHttpError(err);
    return new QuotaError(c);
  }
  const msg = err instanceof Error ? err.message : String(err);
  return new QuotaError({ state: 'upstream_unavailable', message: msg.slice(0, 200) });
}

function resolveCredential(proposed?: QuotaCredentialInput): { key: string; base: string } | null {
  if (proposed?.apiKey) {
    const region = (process.env.MINIMAX_REGION || '').toLowerCase();
    const base = proposed.baseUrl || (region === 'cn' ? 'https://www.minimaxi.com' : 'https://www.minimax.io');
    return { key: proposed.apiKey, base };
  }

  // 0. Key entered in-app (via the credential sheet) — highest priority.
  const stored = readStoredCredential('minimax');
  if (stored) {
    const region = (process.env.MINIMAX_REGION || '').toLowerCase();
    const base = stored.baseUrl || (region === 'cn' ? 'https://www.minimaxi.com' : 'https://www.minimax.io');
    return { key: stored.apiKey, base };
  }

  const key = process.env.MINIMAX_API_KEY || process.env.MINIMAX_SUBSCRIPTION_KEY;
  if (!key) return null;
  // minimax.io = global, minimaxi.com = China.
  const region = (process.env.MINIMAX_REGION || '').toLowerCase();
  const base = region === 'cn'
    ? (process.env.MINIMAX_BASE_URL || 'https://www.minimaxi.com')
    : (process.env.MINIMAX_BASE_URL || 'https://www.minimax.io');
  return { key, base };
}
