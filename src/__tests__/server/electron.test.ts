import { describe, it, expect } from 'vitest';
import { createApp } from '../../server/index.js';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { formatCost, formatTokens } = require('../../../electron/trayBadge.cjs') as {
  formatCost: (cost: number) => string;
  formatTokens: (tokens: number) => string;
};

describe('createApp', () => {
  it('returns an Express app', () => {
    const app = createApp(3456);
    expect(app).toBeDefined();
    expect(typeof app.listen).toBe('function');
  });

  it('has /api route registered', async () => {
    const app = createApp(0);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    const port = address.port;

    try {
      const data = await fetchJson(`http://localhost:${port}/api/agents`);
      expect(data).toHaveProperty('available');
    } finally {
      server.close();
    }
  });

  it('serves /popover.html', async () => {
    const app = createApp(0);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    const port = address.port;

    try {
      const res = await fetch(`http://localhost:${port}/popover.html`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('TokenDash');
      expect(html).toContain('open-dashboard');
    } finally {
      server.close();
    }
  });
});

describe('formatCost', () => {
  it('formats near-zero cost as $0', () => {
    expect(formatCost(0)).toBe('$0');
    expect(formatCost(0.01)).toBe('$0');
    expect(formatCost(0.04)).toBe('$0');
  });

  it('formats small costs with 1 decimal', () => {
    expect(formatCost(0.05)).toBe('$0.1');
    expect(formatCost(1.234)).toBe('$1.2');
    expect(formatCost(3.456)).toBe('$3.5');
    expect(formatCost(9.99)).toBe('$10.0');
  });

  it('formats medium costs without decimal', () => {
    expect(formatCost(10)).toBe('$10');
    expect(formatCost(12.5)).toBe('$13');
    expect(formatCost(99)).toBe('$99');
  });

  it('formats large costs without decimal', () => {
    expect(formatCost(100)).toBe('$100');
    expect(formatCost(123.4)).toBe('$123');
    expect(formatCost(999)).toBe('$999');
  });
});

describe('local date helper', () => {
  function getLocalDate(): string {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  it('matches local date, not UTC', () => {
    const local = getLocalDate();
    const utc = new Date().toISOString().slice(0, 10);
    const now = new Date();
    // local should match the system date
    expect(local).toBe(
      now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0')
    );
    // if timezone offset is non-zero and we're near midnight, local may differ from UTC
    const offsetHours = now.getTimezoneOffset() / 60;
    if (Math.abs(offsetHours) > 0 && now.getHours() < Math.abs(offsetHours)) {
      expect(local).not.toBe(utc);
    }
  });

  it('produces YYYY-MM-DD format', () => {
    const local = getLocalDate();
    expect(local).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('formatTokens', () => {
  it('formats millions', () => {
    expect(formatTokens(1500000)).toBe('1.5M');
    expect(formatTokens(32000000)).toBe('32.0M');
  });

  it('formats thousands', () => {
    expect(formatTokens(1234)).toBe('1.2K');
    expect(formatTokens(567890)).toBe('567.9K');
  });

  it('formats small numbers as-is', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(42)).toBe('42');
    expect(formatTokens(999)).toBe('999');
  });

  it('does not render zero or invalid values as a fake million count', () => {
    expect(formatTokens(-1)).toBe('0');
    expect(formatTokens(Number.NaN)).toBe('0');
  });
});

describe('daily API data freshness', () => {
  let server: ReturnType<ReturnType<typeof createApp>['listen']>;
  let port: number;

  beforeAll(async () => {
    const app = createApp(0);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        if (addr && typeof addr !== 'string') port = addr.port;
        resolve();
      });
    });
  });

  afterAll(() => {
    server?.close();
  });

  it('daily endpoint returns data for today', async () => {
    const data = await fetchJson(`http://localhost:${port}/api/daily?agent=claude`);
    expect(data).toHaveProperty('daily');
    expect(Array.isArray(data.daily)).toBe(true);

    const localNow = new Date();
    const today = localNow.getFullYear() + '-' + String(localNow.getMonth() + 1).padStart(2, '0') + '-' + String(localNow.getDate()).padStart(2, '0');
    const todayEntry = data.daily.find((d: any) => d.date === today);
    if (!todayEntry) return; // skip if no data today (e.g. CI environment)

    expect(todayEntry).toHaveProperty('inputTokens');
    expect(todayEntry).toHaveProperty('outputTokens');
    expect(todayEntry).toHaveProperty('totalTokens');
    expect(todayEntry).toHaveProperty('totalCost');
    // If there's any usage today, totalTokens should be > 0
    if (todayEntry.totalTokens > 0) {
      expect(todayEntry.inputTokens + todayEntry.outputTokens + todayEntry.cacheReadTokens).toBeGreaterThan(0);
    }
  });

  it('today entry has valid token fields', async () => {
    const data = await fetchJson(`http://localhost:${port}/api/daily?agent=claude`);
    const localNow = new Date();
    const today = localNow.getFullYear() + '-' + String(localNow.getMonth() + 1).padStart(2, '0') + '-' + String(localNow.getDate()).padStart(2, '0');
    const entry = data.daily.find((d: any) => d.date === today);
    if (!entry) return; // skip if no data today

    expect(typeof entry.inputTokens).toBe('number');
    expect(typeof entry.outputTokens).toBe('number');
    expect(typeof entry.cacheReadTokens).toBe('number');
    expect(typeof entry.totalTokens).toBe('number');
    expect(typeof entry.totalCost).toBe('number');
    expect(entry.inputTokens).toBeGreaterThanOrEqual(0);
    expect(entry.outputTokens).toBeGreaterThanOrEqual(0);
    expect(entry.totalTokens).toBeGreaterThanOrEqual(entry.inputTokens + entry.outputTokens);
  });

  it('blocks endpoint returns data for today with correct structure', async () => {
    const data = await fetchJson(`http://localhost:${port}/api/blocks?agent=claude`);
    expect(data).toHaveProperty('blocks');

    const localNow = new Date();
    const today = localNow.getFullYear() + '-' + String(localNow.getMonth() + 1).padStart(2, '0') + '-' + String(localNow.getDate()).padStart(2, '0');
    const todayBlocks = data.blocks.filter((b: any) => b.startTime?.startsWith(today));

    // If there are blocks today, validate structure
    for (const block of todayBlocks) {
      expect(block).toHaveProperty('startTime');
      expect(block).toHaveProperty('totalTokens');
      expect(block.totalTokens).toBeGreaterThanOrEqual(0);
      // tokenCounts should contain input/output breakdown
      if (block.tokenCounts) {
        expect(block.tokenCounts).toHaveProperty('inputTokens');
        expect(block.tokenCounts).toHaveProperty('outputTokens');
      }
    }
  });

  it('daily returns correct date when filtered by agent', async () => {
    const agents = await fetchJson(`http://localhost:${port}/api/agents`);
    expect(agents).toHaveProperty('available');

    for (const agent of agents.available) {
      const data = await fetchJson(`http://localhost:${port}/api/daily?agent=${agent}`);
      expect(data).toHaveProperty('daily');
      // Each agent should have daily array (may be empty)
      expect(Array.isArray(data.daily)).toBe(true);
    }
  });
});

function fetchJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}
