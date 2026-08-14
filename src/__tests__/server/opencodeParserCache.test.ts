import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execSync: vi.fn(),
  statSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({ execSync: mocks.execSync }));
vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => true),
  statSync: mocks.statSync,
}));

const parser = await import('../../server/opencodeParser.js');

const message = JSON.stringify({
  role: 'assistant',
  time: { created: Date.UTC(2026, 7, 14, 8) },
  modelID: 'gpt-test',
  tokens: { input: 10, output: 5, cache: { read: 3, write: 2 } },
  cost: 0.01,
  path: { cwd: '/tmp/project-a' },
});

describe('OpenCode source cache', () => {
  beforeEach(() => {
    mocks.execSync.mockReset().mockReturnValue(JSON.stringify([{ data: message }]));
    mocks.statSync.mockReset().mockReturnValue({ mtimeMs: 100, size: 200 });
    parser.clearOpenCodeEventCache();
  });

  it('shares one SQLite scan across daily, projects, and blocks aggregation', () => {
    parser.getDailyResponse();
    parser.getProjectsResponse();
    parser.getBlocksResponse();

    expect(mocks.execSync).toHaveBeenCalledTimes(1);
  });

  it('re-scans when the database fingerprint changes', () => {
    parser.getDailyResponse();
    mocks.statSync.mockReturnValue({ mtimeMs: 101, size: 220 });
    parser.getDailyResponse();

    expect(mocks.execSync).toHaveBeenCalledTimes(2);
  });

  it('filters projects from the shared event set without another SQLite scan', () => {
    expect(parser.parseAllOpenCodeEvents('/tmp/project-a')).toHaveLength(1);
    expect(parser.parseAllOpenCodeEvents('/tmp/project-b')).toHaveLength(0);

    expect(mocks.execSync).toHaveBeenCalledTimes(1);
  });
});
