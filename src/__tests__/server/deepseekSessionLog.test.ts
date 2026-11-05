import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeDeepseekZstd, getDeepseekSessionsDir, readDeepseekSessionLog, scanDeepseekSessions, scanDeepseekZstdFrames } from '../../server/deepseekSessionLog.js';
import { deepseekHeader, deepseekJsonl, deepseekMessage, deepseekZstdFrames, hasSystemZstd, hasZstdEncoder } from '../fixtures/deepseek.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'tokendash-dsh-log-')); vi.stubEnv('DSH_HOME', root); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
function write(name: string, bytes: string | Buffer): string {
  const dir = join(root, 'sessions', 'project', 'session-fixture');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name); writeFileSync(path, bytes); return path;
}

describe('DeepSeek Harness physical logs', () => {
  it('selects only the highest retained format generation', () => {
    write('session.jsonl', deepseekJsonl([{ ...deepseekHeader, version: 0 }]));
    const latest = write('session.v4.jsonl', deepseekJsonl([deepseekHeader, deepseekMessage(1)]));
    expect(scanDeepseekSessions()).toEqual([latest]);
    const future = write('session.v5.jsonl', deepseekJsonl([{ ...deepseekHeader, version: 5 }]));
    expect(scanDeepseekSessions()).toEqual([future]);
    expect(() => readDeepseekSessionLog(future)).toThrow('Unsupported DeepSeek Harness session format V5');
  });

  it('rejects mixed encodings rather than double-counting or silently choosing', () => {
    write('session.v4.jsonl', deepseekJsonl([deepseekHeader]));
    write('session.v4.jsonl.zstd', Buffer.alloc(0));
    expect(() => scanDeepseekSessions()).toThrow('mixed');
  });

  it('uses header cwd and treats only the incomplete raw tail as uncommitted', () => {
    const path = write('session.v4.jsonl', deepseekJsonl([deepseekHeader, deepseekMessage(1)]) + '{"type":"assistant/message"');
    expect(readDeepseekSessionLog(path)).toMatchObject({ header: { cwd: '/work/deepseek-demo' }, inheritedEventCount: 0, events: [{ seq: 1 }] });
    writeFileSync(path, deepseekJsonl([deepseekHeader]) + '{"broken":\n');
    expect(() => readDeepseekSessionLog(path)).toThrow('Corrupt DeepSeek Harness JSONL record');
  });

  it('validates header version and rejects nonmonotonic event identities', () => {
    const path = write('session.v4.jsonl', deepseekJsonl([{ ...deepseekHeader, version: 3 }]));
    expect(() => readDeepseekSessionLog(path)).toThrow('header');
    writeFileSync(path, deepseekJsonl([deepseekHeader, deepseekMessage(2), deepseekMessage(1)]));
    expect(() => readDeepseekSessionLog(path)).toThrow('non-monotonic');
  });

  it('resolves a relative DSH_HOME from cwd', () => {
    vi.stubEnv('DSH_HOME', './synthetic-dsh-home');
    expect(getDeepseekSessionsDir()).toBe(join(process.cwd(), 'synthetic-dsh-home', 'sessions'));
  });

  it.skipIf(!hasZstdEncoder)('decodes every independent native frame and ignores an unfinished final frame', () => {
    const frames = deepseekZstdFrames([deepseekHeader, deepseekMessage(1), deepseekMessage(2)]);
    expect(scanDeepseekZstdFrames(frames).frames).toHaveLength(3);
    const compressedPath = write('session.v4.jsonl.zstd', frames);
    expect(readDeepseekSessionLog(compressedPath).events.map(row => row.seq)).toEqual([1, 2]);
    const cutoff = scanDeepseekZstdFrames(frames).frames[2].start + 8;
    writeFileSync(compressedPath, frames.subarray(0, cutoff));
    expect(readDeepseekSessionLog(compressedPath).events.map(row => row.seq)).toEqual([1]);
  });

  it.skipIf(!hasZstdEncoder)('rejects a checksum failure in a complete frame', () => {
    const frames = deepseekZstdFrames([deepseekHeader, deepseekMessage(1)]);
    frames[frames.length - 1] ^= 0xff;
    expect(() => decodeDeepseekZstd(frames)).toThrow(/Corrupt|Cannot decode/);
  });

  it.skipIf(!hasZstdEncoder || !hasSystemZstd)('system decoder handles concatenated output larger than its usual 1 MiB limit', () => {
    const rows = [deepseekHeader, { ...deepseekMessage(1), syntheticPadding: 'a'.repeat(3 * 1024 * 1024) }, deepseekMessage(2)];
    const frames = deepseekZstdFrames(rows);
    const raw = deepseekJsonl(rows);
    expect(Buffer.byteLength(raw)).toBeGreaterThan(1024 * 1024);
    expect(decodeDeepseekZstd(frames, 'system').toString()).toBe(raw);
    expect(decodeDeepseekZstd(frames).toString()).toBe(raw);
  });

  it.skipIf(!hasZstdEncoder)('reports actionable missing-decoder instructions', () => {
    const frames = deepseekZstdFrames([deepseekHeader]);
    vi.stubEnv('PATH', root);
    expect(() => decodeDeepseekZstd(frames, 'system')).toThrow('Install zstd or use Node 24');
  });
});
