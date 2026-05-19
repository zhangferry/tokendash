import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, afterEach } from 'vitest';
import { buildCodexResponsesFromSessions, parseCodexSession, type ParsedSession } from '../../server/codexParser.js';
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

function tokenCount(timestamp: string, totalTokens: number, outputTokens = 100): unknown {
  const inputTokens = totalTokens - outputTokens;
  return {
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: inputTokens,
          cached_input_tokens: 0,
          output_tokens: outputTokens,
          reasoning_output_tokens: 0,
          total_tokens: totalTokens,
        },
        last_token_usage: {
          input_tokens: inputTokens,
          cached_input_tokens: 0,
          output_tokens: outputTokens,
          reasoning_output_tokens: 0,
          total_tokens: totalTokens,
        },
      },
    },
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
    expect(session?.tokenEvents.map(ev => ev.totalTokens)).toEqual([1500, 2100]);
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

  it('does not count cache reads again in Codex model totals', () => {
    const responses = buildCodexResponsesFromSessions([
      session('s1', '/repo/project-a', 'gpt-5.4', [event('2026-05-18T01:00:00.000Z', 1_000, 50, 900)]),
    ], { timezone: 'UTC' });

    const daily = responses.daily.daily[0];
    const modelTokens = daily.modelBreakdowns.reduce((sum, model) => sum + model.inputTokens + model.outputTokens, 0);
    const modelTokensWithCacheDoubleCounted = daily.modelBreakdowns.reduce(
      (sum, model) => sum + model.inputTokens + model.outputTokens + model.cacheReadTokens,
      0,
    );

    expect(daily.totalTokens).toBe(1_050);
    expect(modelTokens).toBe(daily.totalTokens);
    expect(modelTokensWithCacheDoubleCounted).toBe(1_950);
  });

  it('calculates per-model costs independently instead of splitting evenly', () => {
    const responses = buildCodexResponsesFromSessions([
      session('s1', '/repo/project-a', 'gpt-5.4', [event('2026-05-18T01:00:00.000Z', 10_000, 500)]),
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
