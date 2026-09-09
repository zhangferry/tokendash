import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getSessionDetail, invalidateSessionAnalyticsSource } from '../../server/sessionAnalyticsParser.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'claude-reasoning-'));
  mkdirSync(join(home, 'projects', 'test'), { recursive: true });
  vi.stubEnv('CLAUDE_HOME', home);
  invalidateSessionAnalyticsSource();
});
afterEach(() => {
  invalidateSessionAnalyticsSource();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

function row(second: number, content: unknown[], options: { requestId?: string; id?: string; output?: number; sessionId?: string } = {}) {
  return {
    type: 'assistant', sessionId: options.sessionId ?? 'session', requestId: options.requestId ?? 'request',
    timestamp: `2026-09-08T10:00:${String(second).padStart(2, '0')}.000Z`,
    message: { id: options.id ?? 'message', model: 'claude-sonnet-4-20250514', content,
      usage: { input_tokens: 100, output_tokens: options.output ?? 20 } },
  };
}
function write(rows: unknown[], name = 'session') {
  writeFileSync(join(home, 'projects', 'test', `${name}.jsonl`), rows.map(row => JSON.stringify(row)).join('\n'));
}
const thinking = (text: string) => ({ type: 'thinking', thinking: text });

it('retains reasoning from discarded snapshots in preview and hydrated content without extra usage or calls', () => {
  write([
    row(0, [thinking('Inspect the inputs.')]),
    row(1, [{ type: 'text', text: 'Done.' }]),
    row(2, [thinking('Check the output.'), { type: 'tool_use', id: 'tool', name: 'Read', input: { file_path: 'a.ts' } }], { output: 10 }),
  ]);
  const detail = getSessionDetail('claude', 'session', undefined, true)!;
  const calls = detail.events.filter(event => event.type === 'llm_call');
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ summary: 'Model reasoning', contentAvailable: true,
    content: 'Inspect the inputs. Check the output.', contentPreview: 'Inspect the inputs. Check the output.',
    usage: { totalTokens: 120 } });
  expect(detail.events.filter(event => event.type === 'assistant_message')).toHaveLength(1);
  expect(detail.events.filter(event => event.type === 'tool_call')).toHaveLength(1);
  expect(detail.session.totalTokens).toBe(120);
  expect(detail.session.llmCallCount).toBe(1);
});

it('keeps reasoning isolated by request, session, file, and anonymous row', () => {
  write([
    row(0, [thinking('Request A.')]), row(1, [], { requestId: 'request' }),
    row(2, [thinking('Request B.')], { requestId: 'other' }), row(3, [], { requestId: 'other' }),
    row(4, [thinking('Anonymous A.')], { id: '' }), row(5, [thinking('Anonymous B.')], { id: '' }),
    row(1, [thinking('Other session.')], { sessionId: 'other-session' }),
  ]);
  write([row(1, [thinking('Other file.')], { sessionId: 'other-file-session' })], 'other-file');
  const detail = getSessionDetail('claude', 'session', undefined, true)!;
  expect(detail.events.filter(event => event.type === 'llm_call').map(event => event.content))
    .toEqual(['Request A.', 'Request B.', 'Anonymous A.', 'Anonymous B.']);
  expect(detail.session.totalTokens).toBe(480);
});

it('hydrates reasoning beyond the preview when the selected snapshot has a later timestamp', () => {
  const reasoning = 'Inspect each input and check the resulting output. '.repeat(12).trim();
  write([row(0, [thinking(reasoning)]), row(1, [{ type: 'text', text: 'Finished.' }])]);
  const preview = getSessionDetail('claude', 'session')!.events.find(event => event.type === 'llm_call')!;
  expect(preview.contentAvailable).toBe(true);
  expect(preview.content).toBeUndefined();
  expect(preview.contentPreview!.length).toBeLessThan(reasoning.length);
  const expanded = getSessionDetail('claude', 'session', undefined, true)!.events.find(event => event.type === 'llm_call')!;
  expect(expanded.content).toBe(reasoning);
  expect(expanded.usage).toEqual(preview.usage);
});
