import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const mocks = vi.hoisted(() => ({ home: '', agents: { deepseek: true } as Record<string, boolean> }));
vi.mock('node:os', async importOriginal => ({ ...await importOriginal<typeof import('node:os')>(), homedir: () => mocks.home }));
vi.mock('../../server/agentDetection.js', () => ({ detectAvailableAgents: () => mocks.agents }));

let analytics: typeof import('../../server/sessionAnalyticsParser.js');
let parser: typeof import('../../server/deepseekParser.js');
let schemas: typeof import('../../shared/schemas.js');
const start = Date.now() - 60_000;

function event(seq: number, type: string, data: Record<string, unknown>, time = start + seq * 100) {
  return { type, seq, time, data };
}

function usage(inputTokens: number, outputTokens: number, cacheReadTokens = 0) {
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens: 0, totalTokens: inputTokens + outputTokens + cacheReadTokens };
}

function assistant(seq: number, tokens = usage(3, 1), model = 'deepseek-flash', step = 1) {
  return event(seq, 'assistant/message', {
    turn: 1, step,
    message: { id: 'message-' + seq, role: 'assistant', source: { kind: 'model', provider: 'deepseek-account', model }, content: [{ type: 'reasoning', text: 'Planning safely sk_supersecretcredential123' }, { type: 'text', text: 'Updated the module' }, { type: 'tool-call', id: 'edit-1', name: 'edit', arguments: '{}' }] },
    usage: tokens, stream: [{ type: 'raw', time: start, chunk: { type: 'usage', usage: tokens } }],
  });
}

function log(id: string, events: ReturnType<typeof event>[], seeded = false, version = 4) {
  const file = join(mocks.home, '.dsh', 'sessions', '--project--', id, `session.v${version}.jsonl`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, [
    { type: 'session', version, id, createdAt: start, cwd: '/work/project', isSeeded: seeded }, ...events,
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  return file;
}

function baseEvents() {
  return [
    event(1, 'request/header', { header: { config: { provider: 'deepseek-account', model: 'deepseek-flash' } } }),
    event(2, 'turn/start', { turn: 1 }),
    event(3, 'user/message', { role: 'user', id: 'user-1', content: [{ type: 'text', text: 'Update module api_key=private-user-value' }] }),
    assistant(4, usage(10, 5, 20)),
    assistant(5, usage(12, 6, 20)),
    event(6, 'tool/call', { turn: 1, step: 1, callId: 'edit-1', name: 'edit', arguments: JSON.stringify({ file_path: '/work/project/module.ts', old_string: 'old line', new_string: 'new line\nsecond line', authorization: 'private-tool-value' }) }),
    event(7, 'tool/result', { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'edit-1', isError: false, content: [{ type: 'text', text: 'Saved module' }] } }),
    event(8, 'llm/retry-started', { turn: 1, step: 1 }),
    event(9, 'assistant/attempt', { turn: 1, step: 1, stream: [{ type: 'raw', time: start, chunk: { type: 'usage', usage: usage(4, 2, 10) } }] }),
    event(10, 'llm/retry-started', { turn: 1, step: 1 }),
    assistant(11),
    event(12, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ];
}

beforeAll(async () => {
  mocks.home = mkdtempSync(join(tmpdir(), 'tokendash-deepseek-session-'));
  vi.stubEnv('DSH_HOME', join(mocks.home, '.dsh'));
  vi.stubEnv('CLAUDE_HOME', join(mocks.home, '.claude'));
  vi.stubEnv('TOKENDASH_USAGE_INDEX_DIR', join(mocks.home, 'usage-index'));
  analytics = await import('../../server/sessionAnalyticsParser.js');
  parser = await import('../../server/deepseekParser.js');
  schemas = await import('../../shared/schemas.js');
});

beforeEach(() => {
  rmSync(join(mocks.home, '.dsh'), { recursive: true, force: true });
  rmSync(join(mocks.home, '.claude'), { recursive: true, force: true });
  mocks.agents = { deepseek: true };
  analytics.invalidateSessionAnalyticsSource();
});

afterAll(() => { vi.unstubAllEnvs(); rmSync(mocks.home, { recursive: true, force: true }); });

describe('DeepSeek V4 session indexing', () => {
  it('uses canonical settlements, preserves retries and links tools without duplicating embedded calls', () => {
    log('root', baseEvents());
    const response = schemas.validateSessionAnalytics(analytics.getSessionAnalytics('deepseek'));
    expect(response.summary).toMatchObject({ sessionCount: 1, totalTokens: 58, llmCallCount: 3, toolCallCount: 1, toolSuccessRate: 100 });
    expect(response.capabilities).toMatchObject({ userTurns: true, skills: false, tools: true, toolResults: true, contentPreview: true });
    expect(response.sessions[0]).toMatchObject({ id: 'root', agent: 'deepseek', project: '/work/project', totalTokens: 58, llmCallCount: 3, userTurnCount: 1, status: 'complete' });
    expect(response.sessions[0].skillCallCount).toBeUndefined();
    expect(response.summary.totalTokens).toBe(parser.getDailyResponse().totals.totalTokens);
    const detail = schemas.validateSessionDetail(analytics.getSessionDetail('deepseek', 'root', undefined, true));
    expect(detail.events.filter(row => row.type === 'llm_call').map(row => row.usage?.totalTokens)).toEqual([38, 16, 4]);
    expect(detail.events.filter(row => row.type === 'tool_call')).toHaveLength(1);
    expect(detail.events.find(row => row.type === 'tool_result')).toMatchObject({ callId: 'edit-1', toolName: 'edit', success: true });
    const calls = analytics.extractSessionToolCalls('deepseek', '/work/project');
    expect(calls).toEqual([expect.objectContaining({ toolName: 'Edit', linesAdded: 2, linesDeleted: 1 })]);
  });

  it('redacts retained details, excludes content by default and does not infer Skills from file paths', () => {
    const events = baseEvents();
    events.push(event(13, 'tool/call', { turn: 1, step: 2, callId: 'read-skill', name: 'read', arguments: JSON.stringify({ file_path: '/work/skills/example/SKILL.md' }) }));
    log('safe', events);
    const metadata = analytics.getSessionDetail('deepseek', 'safe')!;
    expect(metadata.events.every(row => row.content === undefined)).toBe(true);
    const detailed = analytics.getSessionDetail('deepseek', 'safe', undefined, true)!;
    const json = JSON.stringify(detailed);
    expect(json).not.toContain('private-user-value');
    expect(json).not.toContain('private-tool-value');
    expect(json).not.toContain('sk_supersecretcredential123');
    expect(json).toContain('[redacted]');
    expect(detailed.events.some(row => row.type === 'skill_call')).toBe(false);
    expect(detailed.capabilities.skills).toBe(false);
  });

  it('distinguishes genuine user turns from Harness runtime user-role messages', () => {
    log('context', [
      event(1, 'user/message', { role: 'user', source: { kind: 'time-context' }, content: [{ type: 'text', text: 'Clock context' }] }),
      event(2, 'user/message', { role: 'user', source: { kind: 'skill-catalog' }, content: [{ type: 'text', text: 'Available skills' }] }),
      event(3, 'user/message', { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Real user request' }] }),
      assistant(4),
    ]);
    const detail = analytics.getSessionDetail('deepseek', 'context')!;
    expect(detail.session).toMatchObject({ userTurnCount: 1, title: 'Real user request' });
    expect(detail.events.filter(row => row.type === 'input_context')).toHaveLength(2);
    expect(detail.events.filter(row => row.type === 'user_message')).toHaveLength(1);
  });

  it('excludes inherited calls and content while restoring the inherited model route', () => {
    log('parent', baseEvents());
    log('child', [
      ...baseEvents(), event(13, 'session/end-seed', { inherited: true }),
      event(14, 'session/end-seed', {}),
      event(15, 'turn/start', { turn: 2 }),
      event(16, 'user/message', { role: 'user', content: [{ type: 'text', text: 'Continue in child' }] }),
      event(17, 'assistant/attempt', { turn: 2, step: 1, stream: [{ type: 'raw', chunk: { type: 'usage', usage: usage(4, 1) } }] }),
      event(18, 'turn/end', { turn: 2, reason: { kind: 'aborted' } }),
    ], true);
    const response = analytics.getSessionAnalytics('deepseek');
    expect(response.summary.totalTokens).toBe(63);
    const child = analytics.getSessionDetail('deepseek', 'child')!;
    expect(child.session).toMatchObject({ totalTokens: 5, userTurnCount: 1, toolCallCount: 0, llmCallCount: 1, models: ['deepseek-flash'], status: 'interrupted' });
    expect(child.events.some(row => row.callId === 'edit-1')).toBe(false);
    expect(child.events.find(row => row.type === 'llm_call')?.usage?.totalTokens).toBe(5);
  });

  it('supports namespaced All details, search, filters, pagination and revision refresh', () => {
    const file = log('a', baseEvents());
    log('b', [event(1, 'user/message', { role: 'user', content: [{ type: 'text', text: 'Different request' }] }), assistant(2, usage(7, 1), 'unpriced-experiment')]);
    const first = analytics.getSessionAnalytics('all', { limit: 1 });
    expect(first.sessions).toHaveLength(1);
    expect(first.sessions[0].id).toMatch(/^deepseek::/);
    const second = analytics.getSessionAnalytics('all', { limit: 1, cursor: first.pagination.nextCursor });
    expect(second.sessions).toHaveLength(1);
    expect(second.sessions[0].id).not.toBe(first.sessions[0].id);
    expect(analytics.getSessionDetail('all', 'deepseek::a')?.session.id).toBe('a');
    expect(analytics.getSessionAnalytics('deepseek', { query: 'Different', model: 'unpriced-experiment', project: '/work/project' }).sessions.map(row => row.id)).toEqual(['b']);
    expect(analytics.getSessionAnalytics('deepseek', { status: 'complete' }).sessions.map(row => row.id)).toEqual(['a']);
    const revision = analytics.getSessionAnalyticsSourceRevision('deepseek');
    appendFileSync(file, JSON.stringify(assistant(13, usage(8, 2), 'deepseek-flash', 2)) + '\n');
    expect(analytics.getSessionAnalyticsSourceRevision('deepseek')).not.toBe(revision);
    expect(analytics.getSessionAnalytics('deepseek', { query: 'a' }).summary.totalTokens).toBe(68);
    expect(analytics.getSessionAnalytics('deepseek').summary.totalTokens).toBe(76);
  });

  it('keeps unknown cost metadata through detail, filtering and All summary', () => {
    log('unknown-price', [event(1, 'user/message', { role: 'user', content: 'Unknown model request' }), assistant(2, usage(7, 1), 'unpriced-experiment')]);
    const detail = schemas.validateSessionDetail(analytics.getSessionDetail('deepseek', 'unknown-price'));
    expect(detail.session.costAvailable).toBe(false);
    expect(detail.events.find(row => row.type === 'llm_call')?.usage?.costAvailable).toBe(false);
    const result = schemas.validateSessionAnalytics(analytics.getSessionAnalytics('all', { range: 'today' }));
    expect(result.summary).toMatchObject({ totalTokens: 8, costAvailable: false });
    expect(result.summary.totalCost).toBeGreaterThan(0); // 兜底价目估算
    expect(result.sessions[0].costAvailable).toBe(false);
  });

  it('retains missing-usage attempts and failed tools without inventing usage or successful edits', () => {
    const events = baseEvents();
    const last = events.at(-1)!;
    events.splice(events.length - 1, 0,
      event(12, 'tool/call', { turn: 1, step: 2, callId: 'failed-edit', name: 'edit', arguments: JSON.stringify({ file_path: 'failed.ts', old_string: 'a', new_string: 'b\nc' }) }),
      event(13, 'tool/result', { turn: 1, step: 2, message: { role: 'tool', toolCallId: 'failed-edit', isError: true, content: [{ type: 'text', text: 'Permission denied' }] } }),
      event(14, 'assistant/attempt', { turn: 1, step: 2, stream: [] }),
    );
    last.seq = 15;
    log('failed', events);
    const detail = analytics.getSessionDetail('deepseek', 'failed')!;
    expect(detail.session).toMatchObject({ totalTokens: 58, llmCallCount: 4, toolCallCount: 2 });
    expect(detail.events.filter(row => row.type === 'llm_call').at(-1)?.usage).toBeUndefined();
    expect(detail.events.find(row => row.callId === 'failed-edit' && row.type === 'tool_result')?.success).toBe(false);
    expect(analytics.extractSessionToolCalls('deepseek').find(row => row.filePath === 'failed.ts')).toMatchObject({ linesAdded: 0, linesDeleted: 0 });
  });

  it('isolates a damaged source in All mode and never returns successful zero when every source fails', () => {
    log('future', [], false, 5);
    mocks.agents = { claude: true, deepseek: true };
    const claude = join(mocks.home, '.claude', 'projects', '-work-healthy', 'healthy.jsonl');
    mkdirSync(dirname(claude), { recursive: true });
    writeFileSync(claude, JSON.stringify({ type: 'assistant', sessionId: 'healthy', timestamp: new Date(start).toISOString(), message: { id: 'claude-1', model: 'claude-sonnet-4', usage: { input_tokens: 10, output_tokens: 2 }, content: [{ type: 'text', text: 'Healthy reply' }] } }) + '\n');
    const result = schemas.validateSessionAnalytics(analytics.getSessionAnalytics('all'));
    expect(result.summary).toMatchObject({ sessionCount: 1, totalTokens: 12, costAvailable: false });
    expect(result.sourceErrors).toEqual([expect.objectContaining({ agent: 'deepseek' })]);
    expect(() => analytics.getSessionAnalytics('deepseek')).toThrow(/version/i);
    mocks.agents = { deepseek: true };
    analytics.invalidateSessionAnalyticsSource();
    expect(() => analytics.getSessionAnalytics('all')).toThrow(/All session sources failed/);
  });

  it('counts pending edit invocations without presenting their requested diff as applied changes', () => {
    log('pending-edit', [
      event(1, 'user/message', { role: 'user', content: 'Edit module' }),
      event(2, 'tool/call', { turn: 1, step: 1, callId: 'pending', name: 'edit', arguments: JSON.stringify({ file_path: 'pending.ts', old_string: 'old', new_string: 'new\nline' }) }),
    ]);
    expect(analytics.getSessionAnalytics('deepseek').summary.toolCallCount).toBe(1);
    expect(analytics.extractSessionToolCalls('deepseek')).toEqual([expect.objectContaining({ toolName: 'Edit', linesAdded: 0, linesDeleted: 0 })]);
  });
});
