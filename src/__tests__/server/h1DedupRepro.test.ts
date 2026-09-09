// H1 repro: Claude Code writes one JSONL line per content block for the SAME
// assistant message, each line carrying the same message.id and possibly growing
// cumulative usage snapshots. Verify whether the parser double-counts.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';

const FIXTURE_HOME = mkdtempSync('/tmp/tokendash-snapshots-');
afterAll(() => rmSync(FIXTURE_HOME, { recursive: true, force: true }));
const PROJ_DIR = join(FIXTURE_HOME, '.claude', 'projects', '-tmp-fixture-demo');

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => FIXTURE_HOME };
});

beforeAll(() => {
  mkdirSync(PROJ_DIR, { recursive: true });
  const usage = { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 5000 };
  const lines = [
    { type: 'assistant', timestamp: '2026-09-05T10:00:00.000Z', message: { id: 'msg_fixture_001', model: 'claude-sonnet-4-6', usage, content: [{ type: 'text', text: 'part1' }] } },
    { type: 'assistant', timestamp: '2026-09-05T10:00:00.000Z', message: { id: 'msg_fixture_001', model: 'claude-sonnet-4-6', usage: { ...usage, output_tokens: 2055 }, content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }] } },
    { type: 'assistant', timestamp: '2026-09-05T10:00:00.000Z', message: { id: 'msg_fixture_001', model: 'claude-sonnet-4-6', usage, content: [{ type: 'text', text: 'part3' }] } },
  ];
  writeFileSync(join(PROJ_DIR, 'session-fixture.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
});

describe('H1: one assistant message split into 3 content-block lines (same message.id, growing usage)', () => {
  it('getDailyResponse should count the message once, not 3x', async () => {
    const { getDailyResponse } = await import('../../server/claudeJsonlParser.js');
    const res = getDailyResponse();
    const day = res.daily.find((d) => d.date === '2026-09-05');
    expect(day, 'daily entry exists').toBeDefined();
    // Correct values (dedup by message.id): input 1000, output 2055, cacheRead 5000, total 8055, cost 0.035325
    expect(day!.inputTokens).toBe(1000);
    expect(day!.outputTokens).toBe(2055);
    expect(day!.cacheReadTokens).toBe(5000);
    expect(day!.totalTokens).toBe(8055);
    expect(day!.totalCost).toBeCloseTo(0.0353, 6);
  });

  it('getBlocksResponse should count the message once, not 3x', async () => {
    const { getBlocksResponse } = await import('../../server/claudeJsonlParser.js');
    const res = getBlocksResponse(null, 'UTC', 'hour');
    const total = res.blocks.reduce((s, b) => s + b.totalTokens, 0);
    expect(total).toBe(8055);
  });
});

it('analytics preserves tool content from later blocks', async () => {
  const { getSessionDetail } = await import('../../server/sessionAnalyticsParser.js');
  const detail = getSessionDetail('claude', 'session-fixture');
  expect(detail).toBeDefined();
  expect(detail!.events.filter(e => e.type === 'tool_call')).toHaveLength(1);
  expect(detail!.events.filter(e => e.type === 'assistant_message')).toHaveLength(2);
  expect(detail!.events.filter(e => e.type === 'llm_call')).toHaveLength(1);
});
