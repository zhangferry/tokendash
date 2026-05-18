import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, afterEach } from 'vitest';
import { parseCodexSession } from '../../server/codexParser.js';

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
