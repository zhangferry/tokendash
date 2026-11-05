import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getBlocksResponse, getDailyResponse, getDeepseekRevision, getProjectsResponse, parseAllDeepseekSessions, parseDeepseekSession } from '../../server/deepseekParser.js';
import { clearUsageFileIndexMemory } from '../../server/usageFileIndex.js';
import { setPricingExchangeRate } from '../../shared/modelPricing.js';
import { deepseekHeader, deepseekEvent, deepseekJsonl, deepseekMessage, deepseekUsage } from '../fixtures/deepseek.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tokendash-dsh-parser-'));
  vi.stubEnv('DSH_HOME', root); vi.stubEnv('TOKENDASH_USAGE_INDEX_DIR', join(root, 'index'));
  clearUsageFileIndexMemory();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); clearUsageFileIndexMemory(); setPricingExchangeRate(6); rmSync(root, { recursive: true, force: true }); });
function write(rows: unknown[], id = 'session-fixture', cwd = '/work/deepseek-demo'): string {
  const dir = join(root, 'sessions', 'project', id); mkdirSync(dir, { recursive: true });
  const path = join(dir, 'session.v4.jsonl');
  writeFileSync(path, deepseekJsonl([{ ...deepseekHeader, id, cwd }, ...rows])); return path;
}

describe('DeepSeek Harness token accounting', () => {
  it('uses disjoint usage buckets once and does not add reasoning a second time', () => {
    const usage = { ...deepseekUsage(100, 50, 200, 30), reasoningTokens: 40 };
    const session = parseDeepseekSession(write([deepseekMessage(1, usage)]))!;
    expect(session.tokenEvents).toHaveLength(1);
    expect(session.tokenEvents[0]).toMatchObject({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 200, cacheWriteTokens: 30, totalTokens: 380 });
    expect(getDailyResponse().totals.totalTokens).toBe(380);
  });

  it('uses the last embedded usage for attempts, replaces a same-step sample, and separately counts a true retry', () => {
    const attempt = deepseekEvent(2, 'assistant/attempt', { turn: 1, step: 1, stream: [
      { type: 'chunk', chunk: { type: 'usage', usage: deepseekUsage(1, 2, 0) } },
      { type: 'chunk', chunk: { type: 'usage', usage: deepseekUsage(10, 20, 0) } },
    ] });
    const path = write([
      deepseekEvent(1, 'request/header', { header: { config: { provider: 'deepseek-account', model: 'deepseek-flash' } } }),
      attempt, deepseekMessage(3, deepseekUsage(20, 30, 0), { step: 1 }),
      deepseekEvent(4, 'llm/retry-started', { turn: 1, step: 1 }),
      deepseekMessage(5, deepseekUsage(50, 60, 0), { step: 1 }),
    ]);
    const events = parseDeepseekSession(path)!.tokenEvents;
    expect(events.map(event => [event.seq, event.totalTokens])).toEqual([[3, 50], [5, 110]]);
    expect(events[0].model).toBe('deepseek-flash');
  });

  it('moves replaced usage to its final settlement day and keeps all aggregations equal', () => {
    const first = Date.parse('2026-11-04T15:59:58Z');
    const second = Date.parse('2026-11-04T16:00:01Z');
    write([deepseekMessage(1, deepseekUsage(100, 10, 0), { step: 1, time: first }), deepseekMessage(2, deepseekUsage(200, 20, 0), { step: 1, time: second })]);
    expect(getDailyResponse().daily.map(day => [day.date, day.totalTokens])).toEqual([['2026-11-05', 220]]);
    expect(Object.values(getProjectsResponse().projects).flat().reduce((sum, day) => sum + day.totalTokens, 0)).toBe(220);
    for (const granularity of ['hour', '15m', '5m'] as const) expect(getBlocksResponse({ granularity }).blocks.reduce((sum, block) => sum + block.totalTokens, 0)).toBe(220);
  });

  it('excludes only tagged inherited history while retaining route metadata', () => {
    const path = write([
      deepseekEvent(1, 'request/header', { header: { config: { provider: 'deepseek-account', model: 'deepseek-flash' } } }),
      deepseekMessage(2, deepseekUsage(1_000, 100, 0)),
      deepseekEvent(3, 'session/end-seed', { inherited: true }),
      deepseekEvent(4, 'assistant/attempt', { turn: 2, step: 1, stream: [{ type: 'chunk', chunk: { type: 'usage', usage: deepseekUsage(10, 2, 0) } }] }),
      deepseekEvent(5, 'session/end-seed', {}),
    ]);
    const header = { ...deepseekHeader, isSeeded: true };
    const lines = readFileSync(path, 'utf8').split('\n');lines[0] = JSON.stringify(header);writeFileSync(path, lines.join('\n'));
    const events = parseDeepseekSession(path)!.tokenEvents;
    expect(events).toHaveLength(1);expect(events[0]).toMatchObject({ model: 'deepseek-flash', totalTokens: 12 });
    write([deepseekMessage(1), deepseekEvent(2, 'session/end-seed', {}), deepseekMessage(3)], 'unseeded');
    expect(getDailyResponse().totals.totalTokens).toBe(652);
  });

  it('tracks route switches and limits the flash pricing alias to official providers', () => {
    const path = write([
      deepseekMessage(1, deepseekUsage(100, 20, 200)),
      deepseekMessage(2, deepseekUsage(100, 20, 200), { provider: 'third-party' }),
      deepseekMessage(3, deepseekUsage(100, 20, 200), { model: 'deepseek-v4-pro' }),
    ]);
    const events = parseDeepseekSession(path)!.tokenEvents;
    expect(events.map(event => event.costAvailable)).toEqual([true, false, true]);
    expect(events[0].cost).toBeGreaterThan(0);
    expect(events[1].cost).toBe(0);
    expect(getDailyResponse().totals.costAvailable).toBe(false);
  });

  it('does not invent token events without provider usage or accept malformed numeric counters', () => {
    const path = write([deepseekEvent(1, 'assistant/attempt', { turn: 1, step: 1, stream: [] })]);
    expect(parseDeepseekSession(path)!.tokenEvents).toEqual([]);
    writeFileSync(path, deepseekJsonl([deepseekHeader, deepseekMessage(1, { ...deepseekUsage(), inputTokens: -1 })]));
    expect(() => parseDeepseekSession(path)).toThrow('inputTokens');
  });

  it('caches only token facts and updates after append, truncation, deletion and price changes', () => {
    const path = write([deepseekMessage(1, deepseekUsage(100, 20, 200))]);
    const revision = getDeepseekRevision();
    expect(getDailyResponse().totals.totalTokens).toBe(320);
    const persisted = readFileSync(join(root, 'index', 'deepseek-sessions.json'), 'utf8');
    expect(persisted).not.toContain('Synthetic fixture answer');
    expect(persisted).not.toContain('costAvailable');
    appendFileSync(path, deepseekJsonl([deepseekMessage(2, deepseekUsage(50, 10, 0))]));
    expect(getDeepseekRevision()).not.toBe(revision);
    expect(getDailyResponse().totals.totalTokens).toBe(380);
    const original = write([deepseekMessage(1, deepseekUsage(1_000_000, 0, 0), { model: 'claude-fable-5', provider: 'test' })], 'pricing');
    const firstCost = parseAllDeepseekSessions().find(session => session.id === 'pricing')!.tokenEvents[0].cost;
    expect(firstCost).toBeGreaterThan(0);
    setPricingExchangeRate(12);
    expect(parseAllDeepseekSessions().find(session => session.id === 'pricing')!.tokenEvents[0].cost).toBeCloseTo(firstCost / 2);
    writeFileSync(path, deepseekJsonl([deepseekHeader]));
    expect(getDailyResponse().totals.totalTokens).toBe(1_000_000);
    rmSync(original);expect(getDailyResponse().totals.totalTokens).toBe(0);
  });

  it('uses the authoritative settlement timestamp for peak reference pricing', () => {
    const path = write([
      deepseekMessage(1, deepseekUsage(1_000_000, 0, 0), { time: Date.parse('2026-11-04T00:00:00Z') }),
      deepseekMessage(2, deepseekUsage(1_000_000, 0, 0), { time: Date.parse('2026-11-04T01:00:00Z') }),
    ]);
    const events = parseDeepseekSession(path)!.tokenEvents;
    expect(events.map(event => event.cost)).toEqual([0.15, 0.3]);
  });

  it('keeps distinct project paths separate and honors project/timezone/realtime filtering', () => {
    const now = Date.parse('2026-11-05T10:00:30Z');
    vi.spyOn(Date, 'now').mockReturnValue(now);
    write([deepseekMessage(1, deepseekUsage(100, 20, 0), { time: now - 60_000 }), deepseekMessage(2, deepseekUsage(200, 20, 0), { time: now - 20 * 60_000 })], 'one', '/work/api/');
    write([deepseekMessage(1, deepseekUsage(300, 30, 0), { time: now - 60_000 })], 'two', '/archive/api');
    expect(Object.keys(getProjectsResponse().projects)).toEqual(['/work/api', '/archive/api']);
    expect(getBlocksResponse({ project: '/work/api', granularity: '1m' }).blocks.reduce((sum, block) => sum + block.totalTokens, 0)).toBe(120);
    expect(getBlocksResponse({ project: '/archive/api' }).blocks.reduce((sum, block) => sum + block.totalTokens, 0)).toBe(330);
    expect(getDailyResponse({ timezone: 'America/Los_Angeles' }).daily[0].date).toBe('2026-11-05');
  });
});
