import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock disk cache to avoid file I/O
vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
}));

// Import after mock
const { cache } = await import('../../server/cache.js');

describe('Cache', () => {
  beforeEach(() => {
    cache.clear();
  });

  it('stores and retrieves fresh data', () => {
    cache.set('key1', { value: 42 });
    expect(cache.get('key1')).toEqual({ value: 42 });
  });

  it('returns null for non-existent key', () => {
    expect(cache.get('missing')).toBeNull();
  });

  it('returns null for expired data via get()', () => {
    cache.set('key1', 'data', 1); // 1ms TTL
    // Wait for expiry
    const now = Date.now();
    vi.setSystemTime(now + 10);
    expect(cache.get('key1')).toBeNull();
    vi.useRealTimers();
  });

  it('getStale returns data even when expired', () => {
    cache.set('key1', 'stale-data', 1);
    const now = Date.now();
    vi.setSystemTime(now + 10);
    // get() returns null, but getStale() should return data
    expect(cache.get('key1')).toBeNull();
    expect(cache.getStale('key1')).toBe('stale-data');
    vi.useRealTimers();
  });

  it('clear removes all data', () => {
    cache.set('a', 1);
    cache.set('b', 2);
    cache.clear();
    expect(cache.get('a')).toBeNull();
    expect(cache.get('b')).toBeNull();
  });

  it('delete removes specific key', () => {
    cache.set('a', 1);
    cache.set('b', 2);
    cache.delete('a');
    expect(cache.get('a')).toBeNull();
    expect(cache.get('b')).toBe(2);
  });

  it('has returns true for fresh data', () => {
    cache.set('key1', 'data');
    expect(cache.has('key1')).toBe(true);
  });

  it('has returns false for expired data', () => {
    cache.set('key1', 'data', 1);
    const now = Date.now();
    vi.setSystemTime(now + 10);
    expect(cache.has('key1')).toBe(false);
    vi.useRealTimers();
  });
});
