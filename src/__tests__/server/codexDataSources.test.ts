import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codexSessionDirsForDataPath, getCodexDataPathStatuses } from '../../server/codexDataSources.js';
import { updateCodexCustomDataPaths } from '../../server/appSettings.js';

const tempDirs: string[] = [];
const originalCodexHome = process.env.CODEX_HOME;
const originalTokendashCodexHome = process.env.TOKENDASH_CODEX_HOME;
const originalTokendashCodexHomes = process.env.TOKENDASH_CODEX_HOMES;
const originalTokendashSettingsFile = process.env.TOKENDASH_SETTINGS_FILE;

beforeEach(() => {
  const settingsDir = mkdtempSync(join(tmpdir(), 'tokendash-settings-'));
  tempDirs.push(settingsDir);
  process.env.TOKENDASH_SETTINGS_FILE = join(settingsDir, 'settings.json');
  delete process.env.TOKENDASH_CODEX_HOME;
  delete process.env.TOKENDASH_CODEX_HOMES;
  // Point the official home at an empty directory so the real ~/.codex never leaks in.
  process.env.CODEX_HOME = settingsDir;
});

afterEach(() => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = originalCodexHome;
  if (originalTokendashCodexHome === undefined) delete process.env.TOKENDASH_CODEX_HOME; else process.env.TOKENDASH_CODEX_HOME = originalTokendashCodexHome;
  if (originalTokendashCodexHomes === undefined) delete process.env.TOKENDASH_CODEX_HOMES; else process.env.TOKENDASH_CODEX_HOMES = originalTokendashCodexHomes;
  if (originalTokendashSettingsFile === undefined) delete process.env.TOKENDASH_SETTINGS_FILE; else process.env.TOKENDASH_SETTINGS_FILE = originalTokendashSettingsFile;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function rollout(id: string): string {
  return `${JSON.stringify({ timestamp: '2026-11-25T10:00:00.000Z', type: 'session_meta', payload: { id, cwd: '/tmp' } })}\n`;
}

const OTHER_JSONL = `${JSON.stringify({ type: 'event', payload: { kind: 'interaction' } })}\n`;

function write(file: string, content: string): string {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

describe('codexSessionDirsForDataPath', () => {
  it('resolves a regular Codex home to its own transcript directories', () => {
    const home = tempDir('tokendash-home-');
    write(join(home, 'sessions', '2026', '11', '25', 'rollout.jsonl'), rollout('a'));
    write(join(home, 'archived_sessions', 'rollout.jsonl.zst'), '');

    expect(codexSessionDirsForDataPath(home)).toEqual([join(home, 'sessions'), join(home, 'archived_sessions')]);
  });

  it('keeps a direct sessions directory that holds rollouts', () => {
    const root = tempDir('tokendash-direct-');
    const sessions = join(root, 'sessions');
    write(join(sessions, '2026', '11', '25', 'rollout.jsonl'), rollout('a'));

    expect(codexSessionDirsForDataPath(sessions)).toEqual([sessions]);
  });

  it('discovers transcript directories nested in a managed session root without assuming its layout', () => {
    const root = tempDir('tokendash-root-');
    const sessionsRoot = join(root, 'sessions');
    const live = join(sessionsRoot, 'alpha', 'agent-plugin-homes', 'codex', 'sessions');
    const archived = join(sessionsRoot, 'beta', 'tools', 'codex', 'archived_sessions');
    const deeper = join(sessionsRoot, 'gamma', 'a', 'b', 'c', 'd', 'sessions');
    write(join(live, '2026', '11', '25', 'rollout-live.jsonl'), rollout('live'));
    write(join(archived, 'rollout-archived.jsonl'), rollout('archived'));
    write(join(deeper, '2026', '11', '25', 'rollout-deep.jsonl'), rollout('deep'));
    write(join(sessionsRoot, 'alpha', 'interactions.jsonl'), OTHER_JSONL);
    write(join(sessionsRoot, 'alpha', 'message-center', 'team-events.jsonl'), OTHER_JSONL);
    write(join(sessionsRoot, 'alpha', 'agent-plugin-homes', 'codex', '.tmp', 'plugin-fixtures', 'transcript.jsonl'), rollout('fixture'));

    expect(codexSessionDirsForDataPath(sessionsRoot)).toEqual([live, archived, deeper].sort());
  });

  it('discovers the Codex home inside a single managed session container', () => {
    const container = tempDir('tokendash-container-');
    const sessions = join(container, 'agent-plugin-homes', 'codex', 'sessions');
    write(join(sessions, '2026', '11', '25', 'rollout.jsonl'), rollout('a'));

    expect(codexSessionDirsForDataPath(container)).toEqual([sessions]);
  });

  it('does not treat JSONL that is not a Codex rollout as a transcript', () => {
    const home = tempDir('tokendash-home-');
    write(join(home, 'sessions', '2026', '11', '25', 'events.jsonl'), OTHER_JSONL);
    const sessions = join(home, 'sessions');

    expect(codexSessionDirsForDataPath(home)).toEqual([sessions, join(home, 'archived_sessions')]);
  });

  it('falls back to the configured directory when nothing inside can be verified', () => {
    const root = tempDir('tokendash-empty-');
    const sessions = join(root, 'sessions');
    mkdirSync(sessions, { recursive: true });
    const archived = join(root, 'archived_sessions');
    write(join(archived, 'rollout.jsonl.zst'), '');

    expect(codexSessionDirsForDataPath(sessions)).toEqual([sessions]);
    expect(codexSessionDirsForDataPath(archived)).toEqual([archived]);
  });

  it('reports nested transcript directories as the readable session dirs of a custom path', () => {
    const root = tempDir('tokendash-status-');
    const sessions = join(root, 'sessions', 'alpha', 'agent-plugin-homes', 'codex', 'sessions');
    write(join(sessions, '2026', '11', '25', 'rollout.jsonl'), rollout('a'));
    updateCodexCustomDataPaths([join(root, 'sessions')]);

    const [status] = getCodexDataPathStatuses().filter(entry => entry.kind === 'custom');
    expect(status.readable).toBe(true);
    expect(status.sessionDirs).toEqual([sessions]);
  });
});
