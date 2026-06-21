import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { QuotaSnapshot } from '../types.js';
import type { QuotaAdapter } from '../adapter.js';
import { QuotaError, baseSnapshot } from '../adapter.js';
import { fetchJsonWithTimeout, HttpError, classifyHttpError, windowFromPercent, windowFromCounts, unixToIso } from '../helpers.js';
import { readStoredCredential } from '../credentialsFile.js';
import type { QuotaCredentialInput } from '../types.js';

/**
 * GLM (Zhipu) Coding Plan adapter.
 *
 * Source: the monitor endpoint used by Z.ai's official usage-query plugin,
 * `GET /api/monitor/usage/quota/limit`. Auth is the API key sent directly
 * in the Authorization header WITHOUT a "Bearer" prefix. Two base domains:
 * api.z.ai (global, ZAI_API_KEY) and open.bigmodel.cn (CN, ZHIPU_API_KEY).
 */

interface GlmLimit {
  type?: string; // "TOKENS_LIMIT" | "TIME_LIMIT"
  unit?: number;        // 3 = hour, 5 = month, 6 = week (observed from GLM monitor API)
  number?: number;      // window size in the given unit
  percentage?: number;
  usage?: number;        // total (for TIME_LIMIT / MCP)
  currentValue?: number; // used (for TIME_LIMIT / MCP)
  remaining?: number;
  nextResetTime?: number; // unix seconds
}

interface GlmQuotaResponse {
  code?: number;
  msg?: string;
  success?: boolean;
  data?: { limits?: GlmLimit[]; level?: string };
}

export const glmAdapter: QuotaAdapter = {
  provider: 'glm',
  displayName: 'GLM Coding Plan',

  async isConfigured(): Promise<boolean> {
    return !!resolveCredential();
  },

  async fetch(options?: { credential?: QuotaCredentialInput }): Promise<QuotaSnapshot> {
    const cred = resolveCredential(options?.credential);
    if (!cred) {
      throw new QuotaError({ state: 'not_configured', message: 'set ZAI_API_KEY or ZHIPU_API_KEY' });
    }

    let data: GlmQuotaResponse;
    try {
      data = (await fetchJsonWithTimeout(`${cred.base}/api/monitor/usage/quota/limit`, {
        headers: {
          // GLM wants the raw key, NOT "Bearer <key>".
          Authorization: cred.key,
          'Accept-Language': 'en-US,en',
          'Content-Type': 'application/json',
        },
      })) as GlmQuotaResponse;
    } catch (err) {
      throw classifyFetchError(err);
    }

    if (!data?.success && data?.code !== 200) {
      throw new QuotaError({ state: 'upstream_unavailable', message: data?.msg || 'GLM quota request failed' });
    }

    const limits = data.data?.limits ?? [];
    const windows = [];

    // TOKENS_LIMIT: two entries (5h + weekly). GLM reports explicit
    // unit/number fields; reset times can overlap in surprising ways, so they
    // are not a safe discriminator for the window kind.
    const tokenLimits = limits
      .filter((l) => l.type === 'TOKENS_LIMIT' && typeof l.percentage === 'number');
    tokenLimits.forEach((l, i) => {
      const kind = tokenWindowKind(l, i);
      windows.push(windowFromPercent(
        kind.id,
        kind.label,
        l.percentage ?? 0,
        { durationMins: kind.durationMins, resetsAt: unixToIso(l.nextResetTime) },
      ));
    });

    // TIME_LIMIT: monthly MCP usage, reported with absolute counts.
    const timeLimit = limits.find((l) => l.type === 'TIME_LIMIT');
    if (timeLimit && typeof timeLimit.usage === 'number') {
      windows.push(windowFromCounts(
        'glm_mcp_monthly',
        'MCP · Monthly',
        timeLimit.currentValue ?? 0,
        timeLimit.usage,
      ));
    }

    const snap = baseSnapshot('glm', 'GLM Coding Plan', {
      planName: data.data?.level ? capitalize(data.data.level) : undefined,
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

function tokenWindowKind(limit: GlmLimit, index: number): { id: string; label: string; durationMins?: number } {
  if (limit.unit === 3 && limit.number === 5) {
    return { id: 'glm_5h', label: '5-Hour Window', durationMins: 300 };
  }
  if (limit.unit === 6 && limit.number === 1) {
    return { id: 'glm_weekly', label: 'Weekly', durationMins: 10080 };
  }

  // Older fixtures, proxies, or API variants may omit unit/number. The monitor
  // API's observed order is 5h first, weekly second, so preserve that contract
  // as the least-surprising fallback.
  if (index === 0) return { id: 'glm_5h', label: '5-Hour Window', durationMins: 300 };
  if (index === 1) return { id: 'glm_weekly', label: 'Weekly', durationMins: 10080 };
  return { id: `glm_tokens_${index}`, label: `Token Window ${index + 1}` };
}

function resolveCredential(proposed?: QuotaCredentialInput): { key: string; base: string } | null {
  if (proposed?.apiKey) {
    return {
      key: proposed.apiKey,
      base: proposed.baseUrl || 'https://open.bigmodel.cn',
    };
  }

  // 0. Key entered in-app (via the credential sheet) — highest priority.
  const stored = readStoredCredential('glm');
  if (stored) return { key: stored.apiKey, base: stored.baseUrl || 'https://open.bigmodel.cn' };

  // 1. Explicit GLM Coding Plan API keys.
  const zai = envOrConfig('ZAI_API_KEY');
  if (zai) return { key: zai, base: envOrConfig('ZAI_BASE_URL') || 'https://api.z.ai' };
  const zhipu = envOrConfig('ZHIPU_API_KEY');
  if (zhipu) return { key: zhipu, base: envOrConfig('ZHIPU_BASE_URL') || 'https://open.bigmodel.cn' };

  // 2. cc-switch / Claude Code scenario: ANTHROPIC_BASE_URL is pointed at a
  // GLM domain (open.bigmodel.cn or api.z.ai) and the plan token lives in
  // ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY. The monitor endpoint shares the
  // same token; we just swap the path from /api/anthropic to /api/monitor/...
  const anthropicBase = envOrConfig('ANTHROPIC_BASE_URL');
  if (anthropicBase && isGlmHost(anthropicBase)) {
    const origin = originOf(anthropicBase);
    const token = envOrConfig('ANTHROPIC_AUTH_TOKEN') || envOrConfig('ANTHROPIC_API_KEY');
    if (origin && token) return { key: token, base: origin };
  }
  return null;
}

function isGlmHost(url: string): boolean {
  const h = url.toLowerCase();
  return h.includes('bigmodel.cn') || h.includes('z.ai');
}

function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/**
 * Read an env var, falling back to the Claude Code settings.json `env` block.
 * Needed because the Swift app launches the daemon from Finder, where the
 * ANTHROPIC_* vars Claude Code injects into its own process are absent — but
 * they're persisted in ~/.claude/settings.json (how cc-switch writes them).
 */
let claudeSettingsEnv: Record<string, string> | null | undefined;
function envOrConfig(key: string): string | undefined {
  if (process.env[key]) return process.env[key];
  if (claudeSettingsEnv === undefined) claudeSettingsEnv = loadClaudeSettingsEnv();
  return claudeSettingsEnv?.[key];
}

function loadClaudeSettingsEnv(): Record<string, string> | null {
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  try {
    const path = join(configDir, 'settings.json');
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed?.env && typeof parsed.env === 'object' ? parsed.env as Record<string, string> : null;
  } catch {
    return null;
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
