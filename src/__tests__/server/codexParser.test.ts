import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, afterEach } from 'vitest';
import { buildCodexResponsesFromSessions, deduplicateParsedSessions, parseCodexSession, type ParsedSession } from '../../server/codexParser.js';
import { calculateCost } from '../../server/codexPricing.js';
import type { DailyEntry, Totals } from '../../shared/types.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function writeSession(lines: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'tokendash-codex-parser-'));
  tempDirs.push(dir);
  const filepath = join(dir, 'session.jsonl');
  writeFileSync(filepath, lines.map(line => JSON.stringify(line)).join('\n'));
  return filepath;
}

function tokenCount(timestamp: string, totalTokens: number, outputTokens = 100, includeLast = true): unknown {
  const inputTokens = totalTokens - outputTokens;
  const info: Record<string, unknown> = {
    total_token_usage: {
      input_tokens: inputTokens,
      cached_input_tokens: 0,
      output_tokens: outputTokens,
      reasoning_output_tokens: 0,
      total_tokens: totalTokens,
    },
  };
  if (includeLast) {
    info.last_token_usage = {
      input_tokens: inputTokens,
      cached_input_tokens: 0,
      output_tokens: outputTokens,
      reasoning_output_tokens: 0,
      total_tokens: totalTokens,
    };
  }
  return {
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info,
    },
  };
}

function turnContext(model: string): unknown {
  return {
    type: 'turn_context',
    payload: { model },
  };
}

function session(id: string, cwd: string, model: string, tokenEvents: ParsedSession['tokenEvents']): ParsedSession {
  return {
    id,
    cwd,
    model,
    createdAt: tokenEvents[0]?.timestamp ?? '2026-05-18T00:00:00.000Z',
    tokenEvents,
  };
}

function event(
  timestamp: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens = 0,
): ParsedSession['tokenEvents'][number] {
  return {
    timestamp,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens: 0,
    totalTokens: inputTokens + outputTokens,
  };
}

function sumDaily(entries: DailyEntry[]): Totals {
  return entries.reduce((acc, entry) => ({
    inputTokens: acc.inputTokens + entry.inputTokens,
    outputTokens: acc.outputTokens + entry.outputTokens,
    cacheCreationTokens: acc.cacheCreationTokens + entry.cacheCreationTokens,
    cacheReadTokens: acc.cacheReadTokens + entry.cacheReadTokens,
    totalTokens: acc.totalTokens + entry.totalTokens,
    totalCost: acc.totalCost + entry.totalCost,
  }), { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0, totalCost: 0 });
}

describe('parseCodexSession', () => {
  it('deduplicates repeated token_count snapshots within a Codex session', () => {
    const filepath = writeSession([
      {
        type: 'session_meta',
        payload: {
          id: 'session-1',
          cwd: '/tmp/project',
          timestamp: '2026-05-18T00:00:00.000Z',
        },
      },
      tokenCount('2026-05-18T00:00:01.000Z', 1500),
      tokenCount('2026-05-18T00:00:02.000Z', 1500),
      tokenCount('2026-05-18T00:00:03.000Z', 2100),
    ]);

    const session = parseCodexSession(filepath);

    expect(session?.tokenEvents).toHaveLength(2);
    expect(session?.tokenEvents.map(ev => ev.totalTokens)).toEqual([1500, 600]);
  });

  it('derives per-turn usage from cumulative total_token_usage when last_token_usage is missing', () => {
    const filepath = writeSession([
      {
        type: 'session_meta',
        payload: {
          id: 'session-1',
          cwd: '/tmp/project',
          timestamp: '2026-05-18T00:00:00.000Z',
        },
      },
      tokenCount('2026-05-18T00:00:01.000Z', 150, 50, false),
      tokenCount('2026-05-18T00:00:02.000Z', 275, 75, false),
    ]);

    const session = parseCodexSession(filepath);

    expect(session?.tokenEvents).toHaveLength(2);
    expect(session?.tokenEvents[0]).toMatchObject({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
    expect(session?.tokenEvents[1]).toMatchObject({ inputTokens: 100, outputTokens: 25, totalTokens: 125 });
  });

  it('does not sum cumulative last_token_usage snapshots for GPT-5.6', () => {
    const filepath = writeSession([
      {
        type: 'session_meta',
        payload: {
          id: 'session-gpt-56',
          cwd: '/tmp/project',
          timestamp: '2026-05-18T00:00:00.000Z',
        },
      },
      turnContext('gpt-5.6-sol'),
      tokenCount('2026-05-18T00:00:01.000Z', 150, 50),
      tokenCount('2026-05-18T00:00:02.000Z', 275, 75),
      tokenCount('2026-05-18T00:00:03.000Z', 550, 150),
    ]);

    const parsed = parseCodexSession(filepath);

    expect(parsed?.tokenEvents.map(ev => ev.totalTokens)).toEqual([150, 125, 275]);
    expect(parsed?.tokenEvents.reduce((sum, ev) => sum + ev.totalTokens, 0)).toBe(550);
  });

  it('skips replayed subagent history before counting its own rollout', () => {
    const filepath = writeSession([
      {
        type: 'session_meta',
        payload: {
          id: 'subagent-1',
          cwd: '/tmp/project',
          timestamp: '2026-05-18T00:00:00.000Z',
          source: { subagent: { thread_spawn: { parent_thread_id: 'parent-1' } } },
        },
      },
      tokenCount('2026-05-18T00:00:01.000Z', 100),
      tokenCount('2026-05-18T00:00:01.000Z', 200),
      tokenCount('2026-05-18T00:00:02.000Z', 300),
    ]);

    const parsed = parseCodexSession(filepath);

    expect(parsed?.tokenEvents.map(ev => ev.totalTokens)).toEqual([100]);
  });

  it('skips fork replay batches identified by fork metadata', () => {
    const forkTime = '2026-07-17T13:32:31.000Z';
    const filepath = writeSession([
      {
        type: 'session_meta',
        payload: {
          id: 'fork-session',
          cwd: '/tmp/project',
          timestamp: forkTime,
          forked_from_id: 'parent-session',
        },
      },
      turnContext('gpt-5.5'),
      tokenCount(forkTime, 50_000),
      tokenCount(`${forkTime.slice(0, -5)}001Z`, 60_000),
      tokenCount(`${forkTime.slice(0, -5)}002Z`, 70_000),
      tokenCount(`${forkTime.slice(0, -5)}003Z`, 80_000),
      tokenCount(`${forkTime.slice(0, -5)}004Z`, 90_000),
      tokenCount(`${forkTime.slice(0, -5)}005Z`, 100_000),
      tokenCount('2026-07-17T13:45:00.000Z', 110_000),
    ]);

    const parsed = parseCodexSession(filepath);

    expect(parsed?.tokenEvents).toHaveLength(1);
    expect(parsed?.tokenEvents[0].timestamp).toBe('2026-07-17T13:45:00.000Z');
  });

  it('does not filter normal sessions with spread-out timestamps', () => {
    const filepath = writeSession([
      {
        type: 'session_meta',
        payload: {
          id: 'normal-session',
          cwd: '/tmp/project',
          timestamp: '2026-07-17T00:00:00.000Z',
        },
      },
      turnContext('gpt-5.5'),
      tokenCount('2026-07-17T00:00:01.000Z', 1_500),
      tokenCount('2026-07-17T00:00:05.000Z', 2_100),
      tokenCount('2026-07-17T00:00:10.000Z', 2_800),
      tokenCount('2026-07-17T00:00:15.000Z', 3_500),
    ]);

    const parsed = parseCodexSession(filepath);

    expect(parsed?.tokenEvents).toHaveLength(4);
  });

  it('attributes token events to the active model when a session switches models', () => {
    const filepath = writeSession([
      {
        type: 'session_meta',
        payload: {
          id: 'session-1',
          cwd: '/tmp/project',
          timestamp: '2026-05-18T00:00:00.000Z',
        },
      },
      turnContext('gpt-5.4'),
      tokenCount('2026-05-18T00:00:01.000Z', 150),
      turnContext('gpt-5.5'),
      tokenCount('2026-05-18T00:00:02.000Z', 125, 25),
    ]);

    const parsed = parseCodexSession(filepath)!;
    const responses = buildCodexResponsesFromSessions([parsed], { timezone: 'UTC' });
    const daily = responses.daily.daily[0];

    expect(parsed.model).toBe('gpt-5.4');
    expect(parsed.tokenEvents.map(ev => ev.model)).toEqual(['gpt-5.4', 'gpt-5.5']);
    expect(daily.modelsUsed.sort()).toEqual(['gpt-5.4', 'gpt-5.5']);
    expect(daily.modelBreakdowns.find(b => b.modelName === 'gpt-5.4')).toMatchObject({ inputTokens: 50, outputTokens: 100 });
    expect(daily.modelBreakdowns.find(b => b.modelName === 'gpt-5.5')).toMatchObject({ inputTokens: 100, outputTokens: 25 });
  });
});

describe('buildCodexResponsesFromSessions', () => {
  it('keeps daily, project table, and block totals consistent', () => {
    const responses = buildCodexResponsesFromSessions([
      session('s1', '/repo/project-a', 'gpt-5.4', [
        event('2026-05-18T01:00:00.000Z', 1_000, 50, 400),
        event('2026-05-18T03:00:00.000Z', 2_000, 100, 500),
      ]),
      session('s2', '/repo/project-a', 'gpt-5.5', [
        event('2026-05-18T04:00:00.000Z', 3_000, 150, 600),
      ]),
      session('s3', '/repo/project-b', 'gpt-5.4', [
        event('2026-05-19T01:00:00.000Z', 4_000, 200, 700),
      ]),
    ], { timezone: 'UTC' });

    const projectEntries = Object.values(responses.projects.projects).flat();
    const projectTotals = sumDaily(projectEntries);
    const blockTotals = responses.blocks.blocks.reduce((acc, block) => ({
      inputTokens: acc.inputTokens + block.tokenCounts.inputTokens,
      outputTokens: acc.outputTokens + block.tokenCounts.outputTokens,
      cacheCreationTokens: acc.cacheCreationTokens + block.tokenCounts.cacheCreationInputTokens,
      cacheReadTokens: acc.cacheReadTokens + block.tokenCounts.cacheReadInputTokens,
      totalTokens: acc.totalTokens + block.totalTokens,
      totalCost: acc.totalCost + block.costUSD,
    }), { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0, totalCost: 0 });

    expect(projectTotals).toMatchObject({
      inputTokens: responses.daily.totals.inputTokens,
      outputTokens: responses.daily.totals.outputTokens,
      cacheCreationTokens: responses.daily.totals.cacheCreationTokens,
      cacheReadTokens: responses.daily.totals.cacheReadTokens,
      totalTokens: responses.daily.totals.totalTokens,
    });
    expect(projectTotals.totalCost).toBeCloseTo(responses.daily.totals.totalCost, 12);
    expect(blockTotals).toMatchObject({
      inputTokens: responses.daily.totals.inputTokens,
      outputTokens: responses.daily.totals.outputTokens,
      cacheCreationTokens: responses.daily.totals.cacheCreationTokens,
      cacheReadTokens: responses.daily.totals.cacheReadTokens,
      totalTokens: responses.daily.totals.totalTokens,
    });
    expect(blockTotals.totalCost).toBeCloseTo(responses.daily.totals.totalCost, 12);
  });

  it('merges multiple same-day sessions into one project table row', () => {
    const responses = buildCodexResponsesFromSessions([
      session('s1', '/repo/project-a', 'gpt-5.4', [event('2026-05-18T01:00:00.000Z', 1_000, 50)]),
      session('s2', '/repo/project-a', 'gpt-5.5', [event('2026-05-18T02:00:00.000Z', 2_000, 100)]),
    ], { timezone: 'UTC' });

    const entries = responses.projects.projects['project-a'];

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      date: '2026-05-18',
      inputTokens: 3_000,
      outputTokens: 150,
      totalTokens: 3_150,
    });
    expect(entries[0].modelsUsed.sort()).toEqual(['gpt-5.4', 'gpt-5.5']);
  });

  it('reports Codex input separately from cached input like ccusage', () => {
    const responses = buildCodexResponsesFromSessions([
      session('s1', '/repo/project-a', 'gpt-5.4', [event('2026-05-18T01:00:00.000Z', 1_000, 50, 900)]),
    ], { timezone: 'UTC' });

    const daily = responses.daily.daily[0];

    expect(daily.inputTokens).toBe(100);
    expect(daily.cacheReadTokens).toBe(900);
    expect(daily.totalTokens).toBe(1_050);
    expect(daily.modelBreakdowns[0]).toMatchObject({ inputTokens: 100, cacheReadTokens: 900, outputTokens: 50 });
  });

  it('calculates per-model costs independently instead of splitting evenly', () => {
    const responses = buildCodexResponsesFromSessions([
      session('s1', '/repo/project-a', 'gpt-5.4', [event('2026-05-18T01:00:00.000Z', 20_000, 1_000)]),
      session('s2', '/repo/project-a', 'gpt-5.5', [event('2026-05-18T02:00:00.000Z', 1_000, 50)]),
    ], { timezone: 'UTC' });

    const daily = responses.daily.daily[0];
    expect(daily.modelBreakdowns).toHaveLength(2);

    const gpt54 = daily.modelBreakdowns.find(b => b.modelName === 'gpt-5.4')!;
    const gpt55 = daily.modelBreakdowns.find(b => b.modelName === 'gpt-5.5')!;

    // gpt-5.4 has 10x the tokens, so its cost should be much higher
    expect(gpt54.cost).toBeGreaterThan(0);
    expect(gpt55.cost).toBeGreaterThan(0);
    expect(gpt54.cost).toBeGreaterThan(gpt55.cost * 5);

    // Verify totalCost is the sum of per-model costs (not evenly split)
    const sumOfModelCosts = gpt54.cost + gpt55.cost;
    expect(sumOfModelCosts).toBeCloseTo(daily.totalCost, 10);

    // Costs should NOT be equal (would happen with even split)
    expect(gpt54.cost).not.toBeCloseTo(gpt55.cost, 5);
  });
});

describe('Codex session merging', () => {
  it('merges overlapping rollout files by cumulative usage snapshot', () => {
    const first = session('overlap', '/repo/project-a', 'gpt-5.6-terra', [
      { ...event('2026-07-10T01:00:00.000Z', 100, 10), usageSnapshotKey: '100:0:10:0:110' },
      { ...event('2026-07-10T01:01:00.000Z', 200, 20), usageSnapshotKey: '300:0:30:0:330' },
    ]);
    const overlapping = session('overlap', '/repo/project-a', 'gpt-5.6-terra', [
      { ...event('2026-07-10T01:00:05.000Z', 100, 10), usageSnapshotKey: '100:0:10:0:110' },
      { ...event('2026-07-10T01:02:00.000Z', 400, 40), usageSnapshotKey: '700:0:70:0:770' },
    ]);

    const merged = deduplicateParsedSessions([first, overlapping]);

    expect(merged).toHaveLength(1);
    expect(merged[0].tokenEvents.map(ev => ev.totalTokens)).toEqual([110, 220, 440]);
  });
});

describe('Codex pricing', () => {
  it('prices gpt-5.5 at twice the gpt-5.4 rate across input, cached input, and output', () => {
    const tokens = {
      inputTokens: 1_000_000,
      cachedInputTokens: 500_000,
      outputTokens: 1_000_000,
      reasoningOutputTokens: 0,
      totalTokens: 2_000_000,
    };

    const gpt54 = calculateCost(tokens, new Set(['gpt-5.4']));
    const gpt55 = calculateCost(tokens, new Set(['gpt-5.5']));

    expect(gpt54).toBeCloseTo(16.375, 6);
    expect(gpt55).toBeCloseTo(32.75, 6);
    expect(gpt55).toBeCloseTo(gpt54 * 2, 6);
  });

  it('normalizes GPT-5.6 aliases and date suffixes to Sol pricing', () => {
    const tokens = {
      inputTokens: 1_000_000,
      cachedInputTokens: 500_000,
      outputTokens: 1_000_000,
      reasoningOutputTokens: 0,
      totalTokens: 2_000_000,
    };

    expect(calculateCost(tokens, new Set(['gpt-5.6']))).toBeCloseTo(32.75, 6);
    expect(calculateCost(tokens, new Set(['gpt-5.6-sol-2026-07-15']))).toBeCloseTo(32.75, 6);
  });

  it('applies GPT-5.6 long-context rates to the individual request portion', () => {
    const tokens = {
      inputTokens: 380_000,
      cachedInputTokens: 70_000,
      outputTokens: 800,
      reasoningOutputTokens: 0,
      totalTokens: 380_800,
      longContextInputTokens: 280_000,
      longContextCachedInputTokens: 20_000,
      longContextOutputTokens: 500,
    };

    expect(calculateCost(tokens, new Set(['gpt-5.6-sol']))).toBeCloseTo(2.9265, 6);
  });
});
