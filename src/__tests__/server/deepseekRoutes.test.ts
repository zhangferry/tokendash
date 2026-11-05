import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';

const state = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async (original) => ({ ...await original<typeof import('node:os')>(), homedir: () => state.home }));

describe('DeepSeek Harness HTTP integration', () => {
  let server: Server;
  let base: string;
  let file: string;
  const now = Date.now();
  const usage = { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 4, totalTokens: 64 };
  const event = (type: string, seq: number, data: unknown) => ({ type, seq, time: now + seq, data });
  const assistant = (seq: number, step: number) => event('assistant/message', seq, {
    turn: 1, step,
    message: { id: `message-${seq}`, role: 'assistant', source: { kind: 'model', provider: 'deepseek-account', model: 'deepseek-flash' }, content: [{ type: 'text', text: 'Implemented and verified.' }] },
    usage,
    stream: [{ type: 'chunk', time: now + seq, chunk: { type: 'usage', usage } }],
  });

  beforeAll(async () => {
    state.home = mkdtempSync(join(tmpdir(), 'tokendash-deepseek-routes-'));
    vi.stubEnv('DSH_HOME', join(state.home, '.dsh'));
    vi.stubEnv('TOKENDASH_USAGE_INDEX_DIR', join(state.home, 'index'));
    const dir = join(state.home, '.dsh', 'sessions', 'project', 'session-test');
    mkdirSync(dir, { recursive: true });
    file = join(dir, 'session.v4.jsonl');
    const rows = [
      { type: 'session', version: 4, id: 'session-test', cwd: '/workspace/harness-project', createdAt: now, isSeeded: false },
      event('request/header', 0, { header: { config: { provider: 'deepseek-account', model: 'deepseek-flash' } }, reason: 'initial' }),
      event('turn/start', 1, { turn: 1 }),
      event('user/message', 2, { id: 'user-1', role: 'user', content: [{ type: 'text', text: 'Inspect the project.' }] }),
      assistant(3, 1),
      event('tool/call', 4, { turn: 1, step: 1, callId: 'read-1', name: 'Read', arguments: '{"path":"src/main.ts"}' }),
      event('tool/result', 5, { turn: 1, step: 1, message: { id: 'result-1', role: 'tool', toolCallId: 'read-1', toolName: 'Read', content: [{ type: 'text', text: 'Source file contents.' }], isError: false }, meta: {} }),
      event('turn/end', 6, { turn: 1, reason: { kind: 'completed' } }),
    ];
    writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    const express = (await import('express')).default;
    const { registerApiRoutes } = await import('../../server/routes/api.js');
    const app = express();
    const router = express.Router();
    registerApiRoutes(router, { packageName: 'test', version: 'test' });
    app.use('/api', router);
    server = await new Promise<Server>(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No HTTP test port');
    base = `http://127.0.0.1:${address.port}/api`;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    vi.unstubAllEnvs();
    rmSync(state.home, { recursive: true, force: true });
  });

  async function get(path: string) {
    const response = await fetch(base + path);
    expect(response.status).toBe(200);
    return response.json();
  }

  it('discovers a DeepSeek-only installation and dispatches every usage endpoint', async () => {
    expect(await get('/agents')).toEqual({ available: ['deepseek'], default: 'deepseek' });
    for (const endpoint of ['daily', 'monthly', 'session']) {
      const response = await get(`/${endpoint}?agent=deepseek&refresh=1`);
      expect(response.totals.totalTokens).toBe(64);
      // This model has no cache-write price; token totals remain exact.
      expect(response.totals.costAvailable).toBe(false);
    }
    const projects = await get('/projects?agent=deepseek&refresh=1');
    expect(Object.keys(projects.projects)).toHaveLength(1);
    expect(Object.values(projects.projects).flat()).toEqual([expect.objectContaining({ totalTokens: 64 })]);
    for (const granularity of ['hour', '15m', '5m', '1m']) {
      const blocks = await get(`/blocks?agent=deepseek&granularity=${granularity}&refresh=1`);
      expect(blocks.blocks.reduce((total: number, block: { totalTokens: number }) => total + block.totalTokens, 0)).toBe(64);
    }
  });

  it('provides real session/tool analytics, searchable details and all-source namespacing', async () => {
    const response = await get('/session-analytics?agent=deepseek&range=all&refresh=1');
    expect(response.summary.totalTokens).toBe(64);
    expect(response.sessions).toHaveLength(1);
    expect(response.sessions[0].userTurnCount).toBe(1);
    expect(response.sessions[0].status).toBe('complete');
    expect(response.capabilities).toMatchObject({ tools: true, userTurns: true, skills: false });
    const detail = await get('/sessions/session-test?agent=deepseek&include=content');
    expect(detail.session.agent).toBe('deepseek');
    expect(detail.events.filter((row: { type: string }) => row.type === 'llm_call')).toHaveLength(1);
    expect(detail.events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'tool_call', callId: 'read-1' })]));
    const all = await get('/session-analytics?agent=all&range=all&refresh=1');
    expect(all.sessions[0].id).toBe('deepseek::session-test');
    const analytics = await get('/analytics?agent=deepseek&refresh=1');
    expect(analytics.toolUsageDistribution).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Read', count: 1 })]));
  });

  it('reparses append-only logs when force-refreshing statistics', async () => {
    appendFileSync(file, JSON.stringify(assistant(7, 2)) + '\n');
    const response = await get('/daily?agent=deepseek&refresh=1');
    expect(response.totals.totalTokens).toBe(128);
    const sessions = await get('/session-analytics?agent=deepseek&range=all&refresh=1');
    expect(sessions.summary.totalTokens).toBe(128);
  });
});
