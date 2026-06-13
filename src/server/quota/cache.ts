import type { QuotaSnapshot } from './types.js';

/**
 * Per-provider quota cache.
 *
 * Keeps the last successful snapshot so a transient refresh failure returns
 * stale-but-useful data (marked freshness "stale") instead of erasing it.
 * The cache is in-memory only — quota snapshots are live and short-lived,
 * so disk persistence (unlike the usage cache) adds no value.
 */
export class QuotaCache {
  private readonly store = new Map<string, { snapshot: QuotaSnapshot; expiresAt: number; updatedAt: number }>();

  constructor(private readonly ttlMs: number = 60_000) {}

  /** Fresh cached snapshot, or null if expired / absent. */
  getFresh(provider: string): QuotaSnapshot | null {
    const entry = this.store.get(provider);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) return null;
    return { ...entry.snapshot, freshness: 'cached' };
  }

  /** Last successful snapshot regardless of TTL (for stale-while-revalidate). */
  getStale(provider: string): QuotaSnapshot | null {
    const entry = this.store.get(provider);
    if (!entry) return null;
    return { ...entry.snapshot, freshness: 'stale' };
  }

  set(snapshot: QuotaSnapshot): void {
    this.store.set(snapshot.provider, {
      snapshot,
      expiresAt: Date.now() + this.ttlMs,
      updatedAt: Date.now(),
    });
  }

  clear(provider?: string): void {
    if (provider) this.store.delete(provider);
    else this.store.clear();
  }
}
