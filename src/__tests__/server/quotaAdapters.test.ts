import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  clampPercent,
  windowFromPercent,
  windowFromCounts,
  unixToIso,
  classifyHttpError,
  HttpError,
} from '../../server/quota/helpers.js';

describe('quota helpers', () => {
  it('clamps percentages to 0-100', () => {
    expect(clampPercent(-5)).toBe(0);
    expect(clampPercent(150)).toBe(100);
    expect(clampPercent(42)).toBe(42);
    expect(clampPercent(NaN)).toBe(0);
  });

  it('windowFromPercent computes remaining = 100 - used', () => {
    const w = windowFromPercent('five_hour', '5-Hour Window', 28, { durationMins: 300 });
    expect(w.usedPercent).toBe(28);
    expect(w.remainingPercent).toBe(72);
    expect(w.durationMins).toBe(300);
  });

  it('windowFromCounts derives percent from used/limit and marks unlimited when limit<=0', () => {
    const w = windowFromCounts('w', 'Weekly', 30, 120);
    expect(w.used).toBe(30);
    expect(w.limit).toBe(120);
    expect(w.usedPercent).toBe(25);
    expect(w.remainingPercent).toBe(75);
    expect(w.isUnlimited).toBeUndefined();

    const unlimited = windowFromCounts('u', 'Boosted', 0, 0);
    expect(unlimited.isUnlimited).toBe(true);
    expect(unlimited.remainingPercent).toBe(100);
  });

  it('unixToIso disambiguates seconds vs milliseconds by magnitude', () => {
    expect(unixToIso(1730947200)).toMatch(/^20/); // seconds
    expect(unixToIso(1730947200000)).toMatch(/^20/); // ms
    expect(unixToIso(null)).toBeUndefined();
    expect(unixToIso(0)).toBeUndefined();
    expect(unixToIso('')).toBeUndefined();
  });

  it('classifyHttpError maps status codes to coarse categories', () => {
    expect(classifyHttpError(new HttpError(401, '')).state).toBe('auth_failed');
    expect(classifyHttpError(new HttpError(403, '')).state).toBe('auth_failed');
    expect(classifyHttpError(new HttpError(429, '')).state).toBe('rate_limited');
    expect(classifyHttpError(new HttpError(500, '')).state).toBe('upstream_unavailable');
  });
});

// --- Adapter normalization tests (mock fetch so no real network) ---

const ENV_BACKUP: Record<string, string | undefined> = {};

function setEnv(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) { delete process.env[k]; }
    else { process.env[k] = v; }
  }
}

function mockFetchJson(payload: unknown, status = 200): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } }),
  ) as unknown as typeof fetch;
}

/** Mock fetch that records the requested URL so we can assert base-path derivation. */
function mockFetchRecording(payload: unknown) {
  const calls: string[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    calls.push(typeof input === 'string' ? input : input.toString());
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

describe('GLM adapter normalization', () => {
  beforeEach(() => {
    ENV_BACKUP.ZAI_API_KEY = process.env.ZAI_API_KEY;
    setEnv({ ZAI_API_KEY: 'test-glm-key' });
  });
  afterEach(() => setEnv({ ZAI_API_KEY: ENV_BACKUP.ZAI_API_KEY }));

  it('orders two TOKENS_LIMIT entries by reset time (5h first, weekly second) and reads MCP TIME_LIMIT', async () => {
    global.fetch = mockFetchJson({
      success: true, code: 200,
      data: {
        level: 'pro',
        limits: [
          { type: 'TOKENS_LIMIT', percentage: 44, nextResetTime: 1731292800 }, // weekly (later reset)
          { type: 'TOKENS_LIMIT', percentage: 7, nextResetTime: 1730947200 },  // 5h (earlier reset)
          { type: 'TIME_LIMIT', percentage: 10, usage: 1000, currentValue: 72, remaining: 928 },
        ],
      },
    });
    const { glmAdapter } = await import('../../server/quota/adapters/glm.js');
    const snap = await glmAdapter.fetch();
    expect(snap.planName).toBe('Pro');
    expect(snap.windows.map((w) => w.id)).toEqual(['glm_5h', 'glm_weekly', 'glm_mcp_monthly']);
    expect(snap.windows[0].usedPercent).toBe(7);
    expect(snap.windows[1].usedPercent).toBe(44);
    const mcp = snap.windows[2];
    expect(mcp.used).toBe(72);
    expect(mcp.limit).toBe(1000);
  });
});

describe('MiniMax adapter normalization (usage_count is REMAINING, not used)', () => {
  beforeEach(() => {
    ENV_BACKUP.MINIMAX_API_KEY = process.env.MINIMAX_API_KEY;
    setEnv({ MINIMAX_API_KEY: 'sk-test' });
  });
  afterEach(() => setEnv({ MINIMAX_API_KEY: ENV_BACKUP.MINIMAX_API_KEY }));

  it('inverts the misnamed usage_count to derive used = total - remaining', async () => {
    global.fetch = mockFetchJson({
      base_resp: { status_code: 0, status_msg: 'success' },
      model_remains: [{
        model_name: 'MiniMax-M2',
        end_time: 1711518000000,
        current_interval_usage_count: 80,   // REMAINING
        current_interval_total_count: 100,  // total → used should be 20
        current_weekly_usage_count: 500,
        current_weekly_total_count: 1000,
      }],
    });
    const { minimaxAdapter } = await import('../../server/quota/adapters/minimax.js');
    const snap = await minimaxAdapter.fetch();
    const five = snap.windows.find((w) => w.id.includes('5h'));
    expect(five?.used).toBe(20);
    expect(five?.limit).toBe(100);
    expect(five?.usedPercent).toBe(20);
  });
});

describe('Kimi adapter normalization (string-typed limit/remaining)', () => {
  beforeEach(() => {
    ENV_BACKUP.KIMI_DATA_DIR = process.env.KIMI_DATA_DIR;
    ENV_BACKUP.HOME = process.env.HOME;
  });
  afterEach(() => {
    setEnv({ KIMI_DATA_DIR: ENV_BACKUP.KIMI_DATA_DIR });
  });

  it('parses STRING-typed limit/remaining into counts and walks the limits[] array', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-cred-'));
    setEnv({ KIMI_DATA_DIR: tmp });
    fs.mkdirSync(path.join(tmp, 'credentials'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'credentials', 'kimi-code.json'),
      JSON.stringify({ access_token: 'tok', refresh_token: 'rt', expires_at: Math.floor(Date.now() / 1000) + 3600 }),
    );

    global.fetch = mockFetchJson({
      usage: { limit: '100', remaining: '74', resetTime: '2026-02-11T17:32:50Z' },
      limits: [{
        window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
        detail: { limit: '100', remaining: '85', resetTime: '2026-02-07T12:32:50Z' },
      }],
      user: { membership: { level: 'LEVEL_INTERMEDIATE' } },
    });

    const { kimiAdapter } = await import('../../server/quota/adapters/kimi.js');
    const snap = await kimiAdapter.fetch();
    // weekly: limit 100, remaining 74 → used 26
    const weekly = snap.windows.find((w) => w.id === 'kimi_weekly');
    expect(weekly?.used).toBe(26);
    expect(weekly?.limit).toBe(100);
    // 5h window: 300 minutes
    const five = snap.windows.find((w) => w.id === 'kimi_limit_0');
    expect(five?.durationMins).toBe(300);
    expect(five?.used).toBe(15);
  });
});

describe('GLM cc-switch scenario (ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL → GLM)', () => {
  beforeEach(() => {
    ENV_BACKUP.ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL;
    ENV_BACKUP.ANTHROPIC_AUTH_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN;
    ENV_BACKUP.ZAI_API_KEY = process.env.ZAI_API_KEY;
    ENV_BACKUP.ZHIPU_API_KEY = process.env.ZHIPU_API_KEY;
    setEnv({ ZAI_API_KEY: undefined, ZHIPU_API_KEY: undefined });
    setEnv({
      ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'glm-plan-token',
    });
  });
  afterEach(() => {
    setEnv({
      ANTHROPIC_BASE_URL: ENV_BACKUP.ANTHROPIC_BASE_URL,
      ANTHROPIC_AUTH_TOKEN: ENV_BACKUP.ANTHROPIC_AUTH_TOKEN,
      ZAI_API_KEY: ENV_BACKUP.ZAI_API_KEY,
      ZHIPU_API_KEY: ENV_BACKUP.ZHIPU_API_KEY,
    });
  });

  it('detects as configured and derives the monitor base from the anthropic origin', async () => {
    const { glmAdapter } = await import('../../server/quota/adapters/glm.js');
    expect(await glmAdapter.isConfigured()).toBe(true);
    const mock = mockFetchRecording({ success: true, code: 200, data: { level: 'pro', limits: [] } });
    global.fetch = mock.fetch;
    await glmAdapter.fetch();
    // The monitor endpoint must use the ORIGIN (open.bigmodel.cn), not the
    // /api/anthropic path, and not api.z.ai.
    expect(mock.calls[0]).toBe('https://open.bigmodel.cn/api/monitor/usage/quota/limit');
  });

  it('does NOT detect when ANTHROPIC_BASE_URL points elsewhere', async () => {
    setEnv({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com' });
    const { glmAdapter } = await import('../../server/quota/adapters/glm.js');
    expect(await glmAdapter.isConfigured()).toBe(false);
  });
});

describe('Claude adapter credential detection', () => {
  it('reports not configured when no credential is reachable', async () => {
    const os = await import('node:os');
    const path = await import('node:path');
    // Point CLAUDE_CONFIG_DIR at an empty temp dir; on non-macOS keychain is skipped.
    const tmp = await import('node:os').then((m) => m.tmpdir());
    const prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
    const prevPlatform = process.platform;
    setEnv({ CLAUDE_CONFIG_DIR: path.join(tmp, 'claude-missing-' + Date.now()) });
    try {
      const { claudeAdapter } = await import('../../server/quota/adapters/claude.js');
      // On macOS this may still find a keychain entry; skip the assertion there.
      if (prevPlatform !== 'darwin') {
        expect(await claudeAdapter.isConfigured()).toBe(false);
      }
    } finally {
      setEnv({ CLAUDE_CONFIG_DIR: prevConfigDir });
      void os;
    }
  });
});
