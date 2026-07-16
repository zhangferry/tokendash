import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, afterEach } from 'vitest';
import { buildCodexResponsesFromSessions, parseCodexSession, type ParsedSession } from '../../server/codexParser.js';
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
    longContextInputTokens: 0,
    longContextCachedInputTokens: 0,
    longContextOutputTokens: 0,
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

  it('prefers cumulative total deltas when last_token_usage looks cumulative', () => {
    const filepath = writeSession([
      {
        type: 'session_meta',
        payload: {
          id: 'session-1',
          cwd: '/tmp/project',
          timestamp: '2026-05-18T00:00:00.000Z',
        },
      },
      turnContext('gpt-5.6'),
      tokenCount('2026-05-18T00:00:01.000Z', 150, 50),
      tokenCount('2026-05-18T00:00:02.000Z', 275, 75),
      tokenCount('2026-05-18T00:00:03.000Z', 550, 150),
    ]);

    const session = parseCodexSession(filepath);

    expect(session?.tokenEvents).toHaveLength(3);
    expect(session?.tokenEvents.map(ev => ev.totalTokens)).toEqual([150, 125, 275]);
    expect(session?.tokenEvents.reduce((sum, ev) => sum + ev.totalTokens, 0)).toBe(550);
  });

  it('marks individual large Codex requests for long-context pricing', () => {
    const filepath = writeSession([
      {
        type: 'session_meta',
        payload: {
          id: 'session-1',
          cwd: '/tmp/project',
          timestamp: '2026-05-18T00:00:00.000Z',
        },
      },
      turnContext('gpt-5.6-sol'),
      tokenCount('2026-05-18T00:00:01.000Z', 280_500, 500),
      tokenCount('2026-05-18T00:00:02.000Z', 380_800, 800),
    ]);

    const session = parseCodexSession(filepath);

    expect(session?.tokenEvents).toHaveLength(2);
    expect(session?.tokenEvents[0]).toMatchObject({
      inputTokens: 280_000,
      outputTokens: 500,
      longContextInputTokens: 280_000,
      longContextOutputTokens: 500,
    });
    expect(session?.tokenEvents[1]).toMatchObject({
      inputTokens: 100_000,
      outputTokens: 300,
      longContextInputTokens: 0,
      longContextOutputTokens: 0,
    });
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

  it('normalizes gpt-5.6 alias and date suffixes to gpt-5.6-sol pricing', () => {
    const tokens = {
      inputTokens: 1_000_000,
      cachedInputTokens: 500_000,
      outputTokens: 1_000_000,
      reasoningOutputTokens: 0,
      totalTokens: 2_000_000,
      longContextInputTokens: 0,
      longContextCachedInputTokens: 0,
      longContextOutputTokens: 0,
    };

    expect(calculateCost(tokens, new Set(['gpt-5.6']))).toBeCloseTo(32.75, 6);
    expect(calculateCost(tokens, new Set(['gpt-5.6-sol-2026-07-15']))).toBeCloseTo(32.75, 6);
  });

  it('applies GPT-5.6 long-context rates only to requests above the threshold', () => {
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

    // short: 50K non-cached * $5 + 50K cached * $0.5 + 300 out * $30
    // long: 260K non-cached * $10 + 20K cached * $1 + 500 out * $45
    expect(calculateCost(tokens, new Set(['gpt-5.6-sol']))).toBeCloseTo(2.9265, 6);
  });
});
