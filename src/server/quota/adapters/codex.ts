import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { QuotaSnapshot } from '../types.js';
import type { QuotaAdapter } from '../adapter.js';
import { QuotaError, baseSnapshot } from '../adapter.js';
import { unixToIso, windowFromPercent } from '../helpers.js';

/**
 * OpenAI Codex adapter.
 *
 * Source: official `codex app-server` JSON-RPC 2.0 method
 * `account/rateLimits/read`. We do NOT read the OAuth token or call the
 * backend usage endpoint directly — the app-server holds the auth and
 * returns authoritative rate limits.
 *
 * Credentials live at `$CODEX_HOME/auth.json` (default ~/.codex/auth.json)
 * or the OS keyring; presence of auth.json is our cheap configured check.
 */

interface CodexRateLimit {
  limitId?: string;
  limitName?: string | null;
  primary?: { usedPercent?: number; windowDurationMins?: number; resetsAt?: number } | null;
  secondary?: { usedPercent?: number; windowDurationMins?: number; resetsAt?: number } | null;
}

interface CodexRateLimitsResult {
  rateLimits?: CodexRateLimit;
  rateLimitsByLimitId?: Record<string, CodexRateLimit>;
  planType?: string;
}

function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex');
}

export const codexAdapter: QuotaAdapter = {
  provider: 'codex',
  displayName: 'OpenAI Codex',

  async isConfigured(): Promise<boolean> {
    // auth.json present signals the user has logged in (file credential store).
    // Keyring-stored creds won't show a file, but the app-server itself is the
    // authority there — so also treat the codex binary being runnable as configured.
    if (existsSync(join(codexHome(), 'auth.json'))) return true;
    return await codexBinaryAvailable();
  },

  async fetch(): Promise<QuotaSnapshot> {
    const result = await queryRateLimits();
    const buckets = result.rateLimitsByLimitId ?? (result.rateLimits ? { primary: result.rateLimits } : {});
    const windows = [];

    for (const [key, bucket] of Object.entries(buckets)) {
      if (bucket.primary) {
        windows.push(windowFromPercent(`codex_${key}_primary`, labelForBucket(key, 'primary', bucket), bucket.primary.usedPercent ?? 0, {
          durationMins: bucket.primary.windowDurationMins,
          resetsAt: unixToIso(bucket.primary.resetsAt),
        }));
      }
      if (bucket.secondary) {
        windows.push(windowFromPercent(`codex_${key}_secondary`, labelForBucket(key, 'secondary', bucket), bucket.secondary.usedPercent ?? 0, {
          durationMins: bucket.secondary.windowDurationMins,
          resetsAt: unixToIso(bucket.secondary.resetsAt),
        }));
      }
    }

    const snap = baseSnapshot('codex', 'OpenAI Codex', {
      planName: result.planType ? capitalize(result.planType) : undefined,
      windows,
    });
    return { ...snap, status: { state: 'ok' } };
  },
};

function labelForBucket(key: string, tier: 'primary' | 'secondary', bucket: CodexRateLimit): string {
  const dur = tier === 'primary' ? bucket.primary?.windowDurationMins : bucket.secondary?.windowDurationMins;
  const durLabel = dur ? durationLabel(dur) : capitalize(tier);
  // Prefer an explicit limit name; fall back to the bucket key, then the tier.
  const who = bucket.limitName || (key && key !== 'primary' ? key : '');
  return who ? `${capitalize(who)} · ${durLabel}` : durLabel;
}

function durationLabel(mins: number): string {
  if (mins >= 10080) return 'Weekly';
  if (mins >= 1440) return `${Math.round(mins / 1440)}-Day`;
  if (mins >= 60) return `${Math.round(mins / 60)}-Hour`;
  return `${mins}m`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// --- JSON-RPC over the codex app-server ---

async function queryRateLimits(): Promise<CodexRateLimitsResult> {
  if (!(await codexBinaryAvailable())) {
    throw new QuotaError({ state: 'not_configured', message: 'codex CLI not found on PATH' });
  }
  const proc = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const client = new JsonRpcClient(proc);
  try {
    await client.request('initialize', {
      protocolVersion: '2025-03-26',
      clientInfo: { name: 'tokendash', version: '1.0.0' },
    });
    client.notify('initialized', {});
    const res = await client.request<CodexRateLimitsResult>('account/rateLimits/read', {});
    return res;
  } catch (err) {
    throw toQuotaError(err);
  } finally {
    client.dispose();
    try { proc.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

function toQuotaError(err: unknown): QuotaError {
  const msg = err instanceof Error ? err.message : String(err);
  if (/not found|ENOENT|spawn/i.test(msg)) {
    return new QuotaError({ state: 'not_configured', message: 'codex app-server unavailable' });
  }
  if (/401|403|unauthor|auth/i.test(msg)) {
    return new QuotaError({ state: 'auth_failed', message: 'codex session not authenticated' });
  }
  return new QuotaError({ state: 'upstream_unavailable', message: msg.slice(0, 200) });
}

/** Minimal line-delimited JSON-RPC 2.0 client over a child process stdio. */
class JsonRpcClient {
  private id = 0;
  private buffer = '';
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private disposed = false;

  constructor(private proc: ChildProcessWithoutNullStreams) {
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => this.onData(chunk));
    proc.on('error', (err) => this.failAll(err));
    proc.on('close', () => this.failAll(new Error('codex app-server closed unexpectedly')));
  }

  request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('client disposed'));
    const id = ++this.id;
    const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.proc.stdin.write(msg, (err) => {
        if (err) reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  notify(method: string, params: unknown): void {
    if (this.disposed) return;
    const msg = JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n';
    this.proc.stdin.write(msg, () => {});
  }

  dispose(): void {
    this.disposed = true;
    this.failAll(new Error('disposed'));
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // skip non-JSON framing lines
      }
      if (msg.id === undefined) continue; // notifications
      const entry = this.pending.get(msg.id);
      if (!entry) continue;
      this.pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(msg.error.message || 'codex JSON-RPC error'));
      else entry.resolve(msg.result);
    }
  }

  private failAll(err: Error): void {
    for (const [, entry] of this.pending) entry.reject(err);
    this.pending.clear();
  }
}

let cachedCodexPath: string | null | undefined;

async function codexBinaryAvailable(): Promise<boolean> {
  if (cachedCodexPath !== undefined) return cachedCodexPath !== null;
  return new Promise<boolean>((resolve) => {
    const proc = spawn('which', ['codex'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    proc.stdout.on('data', (c) => { out += c; });
    proc.on('close', () => {
      cachedCodexPath = out.trim() || null;
      resolve(cachedCodexPath !== null);
    });
    proc.on('error', () => { cachedCodexPath = null; resolve(false); });
  });
}

// Keep readFileSync referenced for potential future auth.json inspection without network.
void readFileSync;
