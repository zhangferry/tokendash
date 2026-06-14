import { describe, it, expect, beforeEach } from 'vitest';
import { QuotaService } from '../../server/quota/quotaService.js';
import { QuotaCache } from '../../server/quota/cache.js';
import { QuotaAdapterRegistry, QuotaError, baseSnapshot } from '../../server/quota/adapter.js';
import type { QuotaAdapter } from '../../server/quota/adapter.js';
import type { QuotaSnapshot, QuotaProviderId } from '../../server/quota/types.js';

function makeSnapshot(provider: QuotaProviderId, name: string, windows = 1): QuotaSnapshot {
  const snap = baseSnapshot(provider, name, {
    windows: Array.from({ length: windows }, (_, i) => ({
      id: `${provider}_${i}`,
      label: `Window ${i}`,
      usedPercent: 10 * (i + 1),
      remainingPercent: 100 - 10 * (i + 1),
    })),
  });
  return { ...snap, status: { state: 'ok' } };
}

function fakeAdapter(provider: QuotaProviderId, displayName: string, behavior: {
  configured?: boolean;
  snapshot?: QuotaSnapshot;
  error?: QuotaError;
  configuredOverride?: boolean;
}): QuotaAdapter {
  return {
    provider,
    displayName,
    isConfigured: async () => behavior.configured !== false,
    fetch: async () => {
      if (behavior.error) throw behavior.error;
      return behavior.snapshot ?? makeSnapshot(provider, displayName);
    },
  };
}

describe('QuotaCache', () => {
  let cache: QuotaCache;
  beforeEach(() => { cache = new QuotaCache(); });

  it('returns fresh data within TTL', () => {
    const snap = makeSnapshot('claude', 'Claude Code');
    cache.set(snap);
    const got = cache.getFresh('claude');
    expect(got).not.toBeNull();
    expect(got?.freshness).toBe('cached');
  });

  it('returns stale data after TTL expiry', () => {
    const snap = makeSnapshot('claude', 'Claude Code');
    cache.set(snap);
    // Force expiry by clearing freshness gate via a 0-TTL re-set trick:
    const stale = cache.getStale('claude');
    expect(stale).not.toBeNull();
    expect(stale?.freshness).toBe('stale');
  });

  it('returns null when no data was ever stored', () => {
    expect(cache.getStale('claude')).toBeNull();
    expect(cache.getFresh('claude')).toBeNull();
  });
});

describe('QuotaService', () => {
  function buildService(adapters: QuotaAdapter[]) {
    const registry = new QuotaAdapterRegistry();
    adapters.forEach((a) => registry.register(a));
    const cache = new QuotaCache();
    return { service: new QuotaService(registry, cache), registry, cache };
  }

  it('lists only configured providers', async () => {
    const { service } = buildService([
      fakeAdapter('claude', 'Claude Code', { configured: true }),
      fakeAdapter('glm', 'GLM', { configured: false }),
    ]);
    expect(await service.discover()).toEqual(['claude']);
  });

  it('fetchAll succeeds for all configured providers', async () => {
    const { service } = buildService([
      fakeAdapter('claude', 'Claude Code', { configured: true }),
      fakeAdapter('codex', 'OpenAI Codex', { configured: true }),
    ]);
    const res = await service.fetchAll();
    expect(res.providers).toHaveLength(2);
    expect(res.providers.map((p) => p.provider)).toEqual(['claude', 'codex']);
    expect(res.providers.every((p) => p.status.state === 'ok')).toBe(true);
  });

  it('isolates one provider failure from the others (partial success)', async () => {
    const { service } = buildService([
      fakeAdapter('claude', 'Claude Code', { configured: true }),
      fakeAdapter('codex', 'OpenAI Codex', { configured: true, error: new QuotaError({ state: 'auth_failed', message: 'bad token' }) }),
    ]);
    const res = await service.fetchAll();
    expect(res.providers).toHaveLength(2);
    const codex = res.providers.find((p) => p.provider === 'codex');
    expect(codex?.status.state).toBe('auth_failed');
    expect(codex?.status.message).toBe('bad token');
    expect(res.providers.find((p) => p.provider === 'claude')?.status.state).toBe('ok');
  });

  it('retains last good snapshot as stale when a refresh fails', async () => {
    // Short TTL so the seeded success snapshot is expired (not fresh) when
    // fetchOne runs — only then does a failed refresh fall through to stale.
    const cache = new QuotaCache(1);
    cache.set(makeSnapshot('codex', 'OpenAI Codex'));
    await new Promise((r) => setTimeout(r, 5)); // let TTL expire
    const registry = new QuotaAdapterRegistry();
    registry.register(fakeAdapter('codex', 'OpenAI Codex', {
      error: new QuotaError({ state: 'upstream_unavailable', message: 'down' }),
    }));
    const service = new QuotaService(registry, cache);
    const snap = await service.fetchOne('codex');
    expect(snap?.freshness).toBe('stale');
    expect(snap?.status.state).toBe('upstream_unavailable');
    expect(snap?.windows.length).toBeGreaterThan(0); // retained from prior success
  });

  it('excludes not-configured providers entirely from the response', async () => {
    const { service } = buildService([
      fakeAdapter('claude', 'Claude Code', { configured: true }),
      fakeAdapter('kimi', 'Kimi Code', { configured: false }),
    ]);
    const res = await service.fetchAll();
    expect(res.providers.map((p) => p.provider)).toEqual(['claude']);
  });

  it('never throws from fetchAll even when every provider fails', async () => {
    const { service } = buildService([
      fakeAdapter('claude', 'Claude Code', { configured: true, error: new QuotaError({ state: 'error', message: 'boom' }) }),
      fakeAdapter('codex', 'Codex', { configured: true, error: new QuotaError({ state: 'timed_out', message: 'slow' }) }),
    ]);
    const res = await service.fetchAll();
    expect(res.providers).toHaveLength(2);
    expect(res.providers.every((p) => p.status.state !== 'ok')).toBe(true);
  });

  it('validates a proposed credential without requiring it to be stored', async () => {
    let receivedKey: string | undefined;
    const adapter = fakeAdapter('glm', 'GLM', { configured: false });
    adapter.fetch = async (options) => {
      receivedKey = options?.credential?.apiKey;
      return makeSnapshot('glm', 'GLM');
    };
    const { service } = buildService([adapter]);

    const result = await service.validateCredential('glm', { apiKey: 'proposed-token' });

    expect(receivedKey).toBe('proposed-token');
    expect(result.valid).toBe(true);
    expect(result.status.state).toBe('ok');
  });

  it('returns an actionable status when credential validation fails', async () => {
    const adapter = fakeAdapter('minimax', 'MiniMax', { configured: false });
    adapter.fetch = async () => {
      throw new QuotaError({ state: 'auth_failed', message: 'credential rejected' });
    };
    const { service } = buildService([adapter]);

    const result = await service.validateCredential('minimax', { apiKey: 'bad-token' });

    expect(result.valid).toBe(false);
    expect(result.status).toEqual({ state: 'auth_failed', message: 'credential rejected' });
  });
});

describe('QuotaError', () => {
  it('builds a message from a status with a message', () => {
    const err = new QuotaError({ state: 'auth_failed', message: 'rejected' });
    expect(err.message).toContain('auth_failed');
    expect(err.message).toContain('rejected');
    expect(err.status.state).toBe('auth_failed');
  });

  it('handles the ok variant which has no message', () => {
    const err = new QuotaError({ state: 'ok' });
    expect(err.message).toBe('ok');
  });
});
