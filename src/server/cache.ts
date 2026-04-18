import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DEFAULT_TTL = 5 * 60 * 1000; // 5 minutes (fresh)
const DISK_TTL = 60 * 60 * 1000;   // 1 hour (stale but usable)

const CACHE_DIR = join(tmpdir(), 'tokendash-cache');

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
  updatedAt: number;
}

function diskPath(key: string): string {
  const safe = key.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(CACHE_DIR, `${safe}.json`);
}

class Cache {
  private store = new Map<string, CacheEntry<unknown>>();

  get<T>(key: string): T | null {
    const entry = this.store.get(key);
    if (entry && Date.now() <= entry.expiresAt) {
      return entry.data as T;
    }
    return null;
  }

  /** Get data even if stale (for stale-while-revalidate) */
  getStale<T>(key: string): T | null {
    // Try memory first
    const entry = this.store.get(key);
    if (entry) return entry.data as T;

    // Try disk
    return this.readFromDisk<T>(key);
  }

  set<T>(key: string, data: T, ttl: number = DEFAULT_TTL): void {
    const entry: CacheEntry<T> = {
      data,
      expiresAt: Date.now() + ttl,
      updatedAt: Date.now(),
    };
    this.store.set(key, entry as CacheEntry<unknown>);
    this.writeToDisk(key, entry);
  }

  clear(): void {
    this.store.clear();
  }

  delete(key: string): boolean {
    return this.store.delete(key);
  }

  has(key: string): boolean {
    const entry = this.store.get(key);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return false;
    }
    return true;
  }

  private writeToDisk<T>(key: string, entry: CacheEntry<T>): void {
    try {
      if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
      writeFileSync(diskPath(key), JSON.stringify(entry), 'utf-8');
    } catch {
      // Disk cache is best-effort
    }
  }

  private readFromDisk<T>(key: string): T | null {
    try {
      const path = diskPath(key);
      if (!existsSync(path)) return null;
      const raw = readFileSync(path, 'utf-8');
      const entry = JSON.parse(raw) as CacheEntry<T>;
      // Only use disk cache if less than DISK_TTL old
      if (Date.now() - entry.updatedAt < DISK_TTL) {
        // Promote to memory cache (with 0 TTL so it'll be treated as stale)
        this.store.set(key, { ...entry, expiresAt: 0 } as CacheEntry<unknown>);
        return entry.data;
      }
    } catch {
      // Disk cache is best-effort
    }
    return null;
  }
}

export const cache = new Cache();
export type { CacheEntry };
