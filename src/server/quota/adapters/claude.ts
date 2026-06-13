import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import type { QuotaSnapshot } from '../types.js';
import type { QuotaAdapter } from '../adapter.js';
import { QuotaError, baseSnapshot } from '../adapter.js';
import { fetchJsonWithTimeout, HttpError, classifyHttpError, windowFromPercent } from '../helpers.js';

/**
 * Claude Code adapter.
 *
 * Authoritative source: Anthropic OAuth usage endpoint
 * `GET https://api.anthropic.com/api/oauth/usage`, called with the locally
 * stored Claude Code OAuth token. This is the same data Claude Code surfaces
 * in its statusline, queried directly so it stays fresh without Claude Code
 * running.
 *
 * Credentials (macOS Keychain `Claude Code-credentials`, or
 * ~/.claude/.credentials.json on other platforms) are read into memory only
 * to build the request and never serialized into the response.
 */

interface ClaudeUsageWindow {
  utilization?: number;
  resets_at?: string;
}

interface ClaudeUsageResponse {
  five_hour?: ClaudeUsageWindow;
  seven_day?: ClaudeUsageWindow;
  seven_day_opus?: ClaudeUsageWindow | null;
  seven_day_oauth_apps?: ClaudeUsageWindow | null;
}

export const claudeAdapter: QuotaAdapter = {
  provider: 'claude',
  displayName: 'Claude Code',

  async isConfigured(): Promise<boolean> {
    const token = readClaudeToken();
    return !!token;
  },

  async fetch(): Promise<QuotaSnapshot> {
    const token = readClaudeToken();
    if (!token) {
      throw new QuotaError({ state: 'not_configured', message: 'no Claude Code OAuth credential found' });
    }
    let data: ClaudeUsageResponse;
    try {
      data = (await fetchJsonWithTimeout('https://api.anthropic.com/api/oauth/usage', {
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'Content-Type': 'application/json',
        },
      })) as ClaudeUsageResponse;
    } catch (err) {
      throw classifyFetchError(err);
    }

    const windows = [];
    if (data.five_hour) {
      windows.push(windowFromPercent('five_hour', '5-Hour Window', data.five_hour.utilization ?? 0, {
        durationMins: 300,
        resetsAt: normalizeIso(data.five_hour.resets_at),
      }));
    }
    if (data.seven_day) {
      windows.push(windowFromPercent('seven_day', 'Weekly', data.seven_day.utilization ?? 0, {
        durationMins: 10080,
        resetsAt: normalizeIso(data.seven_day.resets_at),
      }));
    }
    if (data.seven_day_opus?.utilization !== undefined && data.seven_day_opus?.utilization !== null) {
      windows.push(windowFromPercent('seven_day_opus', 'Weekly · Opus', data.seven_day_opus.utilization, {
        durationMins: 10080,
        resetsAt: normalizeIso(data.seven_day_opus.resets_at),
      }));
    }

    const snap = baseSnapshot('claude', 'Claude Code', { windows });
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

/** The OAuth response returns ISO strings; pass through (normalize Z suffix). */
function normalizeIso(s?: string): string | undefined {
  return s ? new Date(s).toISOString() : undefined;
}

/** Read the Claude Code OAuth access token from keychain (macOS) or file. */
function readClaudeToken(): string | null {
  if (process.platform === 'darwin') {
    const token = readFromKeychain();
    if (token) return token;
    // Fall through to file for headless/SSH sessions where keychain is locked.
  }
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  const credPath = join(configDir, '.credentials.json');
  if (existsSync(credPath)) {
    try {
      const parsed = JSON.parse(readFileSync(credPath, 'utf8'));
      return parsed?.claudeAiOauth?.accessToken ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

function readFromKeychain(): string | null {
  // Keychain entries may carry a per-installation GUID suffix; try the base
  // name first, then any matching suffix.
  const candidates = ['Claude Code-credentials'];
  try {
    const list = execFileSync('security', ['dump-keychain'], { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
    for (const m of list.matchAll(/"srvname"<blob>="([^"]*Claude Code-credentials[^"]*)"/g)) {
      if (m[1] && !candidates.includes(m[1])) candidates.push(m[1]);
    }
  } catch {
    // dump-keychain may prompt or fail; base name is the common case.
  }
  for (const name of candidates) {
    try {
      const raw = execFileSync('security', ['find-generic-password', '-s', name, '-w'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf8',
      }).trim();
      if (!raw) continue;
      // The stored value is itself a JSON blob holding the OAuth tokens.
      try {
        const parsed = JSON.parse(raw);
        return parsed?.claudeAiOauth?.accessToken ?? null;
      } catch {
        return raw; // already a bare token in some setups
      }
    } catch {
      continue;
    }
  }
  return null;
}
