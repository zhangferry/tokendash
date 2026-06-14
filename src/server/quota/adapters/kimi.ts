import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { readStoredCredential } from '../credentialsFile.js';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { QuotaSnapshot } from '../types.js';
import type { QuotaAdapter } from '../adapter.js';
import { QuotaError, baseSnapshot } from '../adapter.js';
import { fetchJsonWithTimeout, HttpError, classifyHttpError, windowFromCounts } from '../helpers.js';
import type { QuotaCredentialInput } from '../types.js';

/**
 * Kimi Code adapter.
 *
 * Source: `GET https://api.kimi.com/coding/v1/usages`, Bearer auth with the
 * OAuth token stored by the Kimi CLI at ~/.kimi/credentials/kimi-code.json.
 * Returns a primary weekly `usage` block plus an arbitrary-length `limits[]`
 * array of windows (e.g. a 5-hour rolling window).
 *
 * Token lifetime is ~1h, so we refresh it from auth.kimi.com before it
 * expires and persist the new tokens back to the same file (the Kimi CLI
 * reads the same file, so both stay in sync).
 */

const KIMI_CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098';
const KIMI_BASE = 'https://api.kimi.com/coding/v1';
const KIMI_AUTH = 'https://auth.kimi.com/api/oauth/token';

interface KimiCredentials {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number; // unix seconds
  scope?: string;
  token_type?: string;
}

interface KimiQuotaDetail {
  limit?: string | number; // STRING-typed upstream
  remaining?: string | number;
  resetTime?: string;
}

interface KimiUsageResponse {
  usage?: KimiQuotaDetail;            // weekly
  limits?: { window?: { duration?: number; timeUnit?: string }; detail?: KimiQuotaDetail }[];
  user?: { membership?: { level?: string } };
}

interface TokenRefreshResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number; // seconds
  token_type?: string;
}

export const kimiAdapter: QuotaAdapter = {
  provider: 'kimi',
  displayName: 'Kimi Code',

  async isConfigured(): Promise<boolean> {
    const cred = readCredentials();
    return !!cred && !!cred.access_token;
  },

  async fetch(options?: { credential?: QuotaCredentialInput }): Promise<QuotaSnapshot> {
    const credPath = credentialsPath();
    let cred = options?.credential?.apiKey
      ? { access_token: options.credential.apiKey, token_type: 'Bearer' }
      : readCredentials();
    if (!cred || !cred.access_token) {
      throw new QuotaError({ state: 'not_configured', message: 'run `kimi` to log in first' });
    }

    // Refresh proactively if within 5 min of expiry.
    const nowSec = Math.floor(Date.now() / 1000);
    if (cred.expires_at && cred.expires_at - nowSec < 300 && cred.refresh_token) {
      cred = await refreshToken(credPath, cred.refresh_token).catch(() => cred!);
    }

    let data: KimiUsageResponse;
    try {
      data = (await fetchJsonWithTimeout(`${KIMI_BASE}/usages`, {
        headers: {
          Authorization: `Bearer ${cred.access_token}`,
          Accept: 'application/json',
        },
      })) as KimiUsageResponse;
    } catch (err) {
      throw classifyFetchError(err);
    }

    const windows = [];

    // Primary weekly usage.
    if (data.usage) {
      const { used, limit } = toCounts(data.usage);
      if (limit > 0) {
        windows.push(windowFromCounts('kimi_weekly', 'Weekly', used, limit, {
          durationMins: 10080,
          resetsAt: normalizeIso(data.usage.resetTime),
        }));
      }
    }

    // Arbitrary-length limits[] (e.g. 5-hour rolling window).
    for (let i = 0; i < (data.limits?.length ?? 0); i++) {
      const entry = data.limits![i];
      const detail = entry?.detail;
      if (!detail) continue;
      const { used, limit } = toCounts(detail);
      if (limit <= 0) continue;
      const mins = minutesForWindow(entry?.window);
      windows.push(windowFromCounts(`kimi_limit_${i}`, mins ? `${durationLabel(mins)} Window` : `Window ${i + 1}`, used, limit, {
        durationMins: mins,
        resetsAt: normalizeIso(detail.resetTime),
      }));
    }

    const snap = baseSnapshot('kimi', 'Kimi Code', {
      planName: data.user?.membership?.level ? prettifyLevel(data.user.membership.level) : undefined,
      windows,
    });
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

/** Kimi returns limit/remaining as STRINGS — coerce and invert to used. */
function toCounts(detail: KimiQuotaDetail): { used: number; limit: number } {
  const limit = toNumber(detail.limit);
  const remaining = toNumber(detail.remaining);
  if (limit <= 0) return { used: 0, limit: 0 };
  return { used: Math.max(0, limit - remaining), limit };
}

function toNumber(v: string | number | undefined): number {
  if (v === undefined || v === null) return 0;
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : 0;
}

function minutesForWindow(window?: { duration?: number; timeUnit?: string }): number | undefined {
  if (!window?.duration) return undefined;
  const unit = (window.timeUnit || '').toUpperCase();
  if (unit.includes('HOUR')) return window.duration * 60;
  if (unit.includes('DAY')) return window.duration * 1440;
  return window.duration; // default minutes
}

function durationLabel(mins: number): string {
  if (mins >= 10080) return 'Weekly';
  if (mins >= 1440) return `${Math.round(mins / 1440)}-Day`;
  if (mins >= 60) return `${Math.round(mins / 60)}-Hour`;
  return `${mins}m`;
}

function normalizeIso(s?: string): string | undefined {
  return s ? new Date(s).toISOString() : undefined;
}

function prettifyLevel(level: string): string {
  // "LEVEL_INTERMEDIATE" -> "Intermediate"
  return level.replace(/^LEVEL_/, '').toLowerCase().replace(/(^|_)(\w)/g, (_, __, c: string) => ' ' + c.toUpperCase()).trim();
}

function kimiDataDir(): string {
  return process.env.KIMI_DATA_DIR || join(homedir(), '.kimi');
}

function credentialsPath(): string {
  return join(kimiDataDir(), 'credentials', 'kimi-code.json');
}

function readCredentials(): KimiCredentials | null {
  // 0. Token entered in-app (via the credential sheet) — highest priority.
  // Treated as a bare access token; no refresh token, so it's used as-is.
  const stored = readStoredCredential('kimi');
  if (stored?.apiKey) {
    return { access_token: stored.apiKey, token_type: 'Bearer' };
  }

  const path = credentialsPath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as KimiCredentials;
  } catch {
    return null;
  }
}

async function refreshToken(credPath: string, refreshToken: string): Promise<KimiCredentials> {
  const body = new URLSearchParams({
    client_id: KIMI_CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  const res = await fetch(KIMI_AUTH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`token refresh failed: HTTP ${res.status}`);
  const tokens = (await res.json()) as TokenRefreshResponse;
  const updated: KimiCredentials = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || refreshToken,
    expires_at: Math.floor(Date.now() / 1000) + (tokens.expires_in ?? 3600),
    token_type: tokens.token_type || 'Bearer',
  };
  // Persist back so the Kimi CLI and this adapter share the refreshed token.
  try {
    writeFileSync(credPath, JSON.stringify(updated, null, 2), 'utf8');
  } catch {
    // Best-effort; the in-memory token still works for this request.
  }
  return updated;
}
