import type { QuotaWindow } from './types.js';

/** Shared helpers for provider adapters. */

/** Convert a Unix timestamp (seconds or ms) to ISO 8601, or undefined. */
export function unixToIso(unix: number | string | null | undefined): string | undefined {
  if (unix === null || unix === undefined || unix === '') return undefined;
  const n = typeof unix === 'string' ? parseInt(unix, 10) : unix;
  if (!Number.isFinite(n) || n <= 0) return undefined;
  // Codex/MiniMax use seconds or ms; disambiguate by magnitude.
  const ms = n > 1e12 ? n : n * 1000;
  return new Date(ms).toISOString();
}

/** Clamp a percentage to 0-100. */
export function clampPercent(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, v));
}

/** Round to 1 decimal place so 61.1999... → 61.2, integers unchanged. */
function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/** Build a QuotaWindow from used/limit percentages. */
export function windowFromPercent(
  id: string,
  label: string,
  usedPercent: number,
  opts: { durationMins?: number; resetsAt?: string; used?: number; limit?: number; modelName?: string; isUnlimited?: boolean } = {},
): QuotaWindow {
  const used = round1(clampPercent(usedPercent));
  return {
    id,
    label,
    usedPercent: used,
    remainingPercent: round1(100 - used),
    durationMins: opts.durationMins,
    resetsAt: opts.resetsAt,
    used: opts.used,
    limit: opts.limit,
    modelName: opts.modelName,
    isUnlimited: opts.isUnlimited,
  };
}

/** Build a QuotaWindow from absolute used/limit counts. */
export function windowFromCounts(
  id: string,
  label: string,
  used: number,
  limit: number,
  opts: { durationMins?: number; resetsAt?: string; modelName?: string } = {},
): QuotaWindow {
  if (limit <= 0) {
    return { id, label, usedPercent: 0, remainingPercent: 100, used, limit, isUnlimited: true, ...opts };
  }
  const pct = round1(clampPercent((used / limit) * 100));
  return {
    id,
    label,
    usedPercent: pct,
    remainingPercent: round1(100 - pct),
    used,
    limit,
    ...opts,
  };
}

/**
 * Fetch JSON with a timeout. Adapters that hit HTTP APIs use this so they
 * share redaction + abort behavior. Returns parsed JSON or throws.
 */
export async function fetchJsonWithTimeout(
  url: string,
  opts: { headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 8_000);
  try {
    const res = await fetch(url, { headers: opts.headers, signal: ctrl.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new HttpError(res.status, body.slice(0, 200));
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export class HttpError extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(`HTTP ${status}`);
    this.name = 'HttpError';
  }
}

/** Map an HTTP status to a coarse auth/upstream classification. */
export function classifyHttpError(err: HttpError): { state: 'auth_failed' | 'rate_limited' | 'upstream_unavailable'; message: string } {
  if (err.status === 401 || err.status === 403) {
    return { state: 'auth_failed', message: 'credential rejected by provider' };
  }
  if (err.status === 429) {
    return { state: 'rate_limited', message: 'provider throttled the request' };
  }
  return { state: 'upstream_unavailable', message: `provider returned HTTP ${err.status}` };
}
