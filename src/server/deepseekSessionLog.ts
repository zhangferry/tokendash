import { readFileSync, readdirSync, accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as zlib from 'node:zlib';

export interface DeepseekHeader {
  type: 'session';
  version: number;
  id: string;
  createdAt: number;
  cwd?: string;
  isSeeded?: boolean;
  parentSession?: unknown;
  origin?: string;
  [key: string]: unknown;
}

export interface DeepseekEvent {
  type: string;
  seq: number;
  time: number;
  data: Record<string, any>;
  [key: string]: unknown;
}

export interface DeepseekSessionLog {
  header: DeepseekHeader;
  events: DeepseekEvent[];
  /** Own events start at this array offset, after the final inherited marker. */
  inheritedEventCount: number;
}

const LOG_NAME = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/;
const ZSTD_MAGIC = 0xfd2fb528;
const MAX_DECODED_BYTES = 512 * 1024 * 1024;

/**
 * Directories appended to the inherited PATH when looking for the optional
 * `zstd` fallback. A daemon started from Finder/LaunchServices only receives
 * `/usr/bin:/bin:/usr/sbin:/sbin`, so Homebrew/MacPorts installs are otherwise
 * invisible even though the user has `zstd` installed.
 */
const ZSTD_FALLBACK_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/opt/local/bin',
  '/usr/bin',
  '/bin',
];

export function zstdSearchDirs(pathValue = process.env.PATH ?? ''): string[] {
  const inherited = pathValue.split(delimiter).filter(Boolean);
  return [...new Set([...inherited, ...ZSTD_FALLBACK_DIRS])];
}

export function getDeepseekSessionsDir(): string {
  let home = process.env.DSH_HOME?.trim();
  if (!home) home = join(homedir(), '.dsh');
  else if (home === '~') home = homedir();
  else if (/^~[\\/]/.test(home)) home = join(homedir(), home.slice(2));
  return join(resolve(home), 'sessions');
}

/** Select exactly one canonical generation per session, never retained ancestors. */
export function scanDeepseekSessions(): string[] {
  const result: string[] = [];
  function walk(dir: string): void {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new Error(`Cannot read DeepSeek Harness session directory: ${dir}`, { cause: error });
    }
    const logs = entries.filter(entry => entry.isFile() && LOG_NAME.test(entry.name));
    if (logs.length) {
      const encodings = new Set(logs.map(entry => entry.name.endsWith('.zstd')));
      if (encodings.size > 1) throw new Error(`Ambiguous mixed DeepSeek Harness log encodings: ${dir}`);
      logs.sort((a, b) => Number(LOG_NAME.exec(b.name)![1] ?? 0) - Number(LOG_NAME.exec(a.name)![1] ?? 0));
      result.push(join(dir, logs[0].name));
    }
    for (const entry of entries) if (entry.isDirectory()) walk(join(dir, entry.name));
  }
  walk(getDeepseekSessionsDir());
  return result.sort();
}

export function isDeepseekAccessible(): boolean {
  try {
    accessSync(getDeepseekSessionsDir(), constants.R_OK);
    return readdirSync(getDeepseekSessionsDir(), { withFileTypes: true }).some(entry => entry.isDirectory());
  } catch { return false; }
}

/** @license
 * Locate standard frame boundaries before decoding. The format is a stream of
 * independent checksummed frames, not one Zstandard frame for the whole file.
 * Derived from DeepSeek Harness (MIT), Copyright (c) 2026 DeepSeek:
 * https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/packages/session/session-persistence-jsonl/src/zstd.ts
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
export function scanDeepseekZstdFrames(buffer: Buffer): { frames: { start: number; end: number }[]; completeBytes: number } {
  const frames: { start: number; end: number }[] = [];
  let offset = 0;
  let completeBytes = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) break;
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`Corrupt DeepSeek Zstandard frame magic at byte ${offset}`);
    offset += 4;
    if (offset === buffer.length) break;
    const descriptor = buffer[offset++];
    if (descriptor & 0x18) throw new Error('Corrupt DeepSeek Zstandard frame header');
    const single = (descriptor & 0x20) !== 0;
    const sizeFlag = descriptor >>> 6;
    const dictionaryFlag = descriptor & 3;
    const headerBytes = (single ? 0 : 1) + (dictionaryFlag === 3 ? 4 : dictionaryFlag) + (sizeFlag === 0 ? (single ? 1 : 0) : 1 << sizeFlag);
    if (buffer.length - offset < headerBytes) break;
    offset += headerBytes;
    let torn = false;
    for (;;) {
      if (buffer.length - offset < 3) { torn = true; break; }
      const block = buffer.readUIntLE(offset, 3);
      offset += 3;
      const type = (block >>> 1) & 3;
      if (type === 3) throw new Error('Corrupt DeepSeek Zstandard block type');
      const bytes = type === 1 ? 1 : block >>> 3;
      if (buffer.length - offset < bytes) { torn = true; break; }
      offset += bytes;
      if (block & 1) break;
    }
    if (torn) break;
    if (descriptor & 4) {
      if (buffer.length - offset < 4) break;
      offset += 4;
    }
    frames.push({ start, end: offset });
    completeBytes = offset;
  }
  return { frames, completeBytes };
}

/**
 * Optional decoder selection and search directories are injectable for
 * portability regression tests.
 */
export function decodeDeepseekZstd(
  buffer: Buffer,
  decoder: 'auto' | 'system' = 'auto',
  searchDirs: string[] = zstdSearchDirs(),
): Buffer {
  const { frames, completeBytes } = scanDeepseekZstdFrames(buffer);
  if (!frames.length) throw new Error('DeepSeek Harness compressed log has no complete header frame yet');
  const native = (zlib as unknown as { zstdDecompressSync?: (input: Buffer, options?: { maxOutputLength: number }) => Buffer }).zstdDecompressSync;
  if (decoder === 'auto' && native) {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for (const frame of frames) {
      try {
        const decoded = native(buffer.subarray(frame.start, frame.end), { maxOutputLength: MAX_DECODED_BYTES - bytes });
        bytes += decoded.length;
        chunks.push(decoded);
      } catch (error) { throw new Error('Corrupt DeepSeek Harness Zstandard frame or decoded log exceeds 512 MiB', { cause: error }); }
    }
    return Buffer.concat(chunks, bytes);
  }
  const executableName = process.platform === 'win32' ? 'zstd.exe' : 'zstd';
  const executables = [...new Set(searchDirs.map(dir => join(dir, executableName)))];
  for (const executable of executables) {
    const result = spawnSync(executable, ['-d', '-q', '-c'], {
      input: buffer.subarray(0, completeBytes), maxBuffer: MAX_DECODED_BYTES, timeout: 30_000,
    });
    if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') continue;
    if (result.error || result.status !== 0) throw new Error('Cannot decode DeepSeek Harness Zstandard log (corrupt frame, timeout, or output exceeds 512 MiB)', { cause: result.error });
    return result.stdout;
  }
  throw new Error('Reading compressed DeepSeek Harness logs requires Node with Zstandard support or a zstd executable (checked PATH, /opt/homebrew/bin and /usr/local/bin). Install zstd or use Node 24.');
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readDeepseekSessionLog(path: string): DeepseekSessionLog {
  const filename = LOG_NAME.exec(basename(path));
  if (!filename) throw new Error(`Not a canonical DeepSeek Harness session log: ${path}`);
  const version = Number(filename[1] ?? 0);
  if (version !== 4) throw new Error(`Unsupported DeepSeek Harness session format V${version}; this version supports V4. Update Harness to migrate historical sessions.`);
  const bytes = readFileSync(path);
  const content = filename[2] ? decodeDeepseekZstd(bytes).toString('utf8') : bytes.toString('utf8');
  if (filename[2] && !content.endsWith('\n')) throw new Error('Corrupt DeepSeek Harness committed frame: unterminated JSONL record');
  // Durable writers terminate every committed JSON record with a newline.
  const complete = content.slice(0, content.lastIndexOf('\n') + 1);
  const rows: unknown[] = [];
  for (const [index, line] of complete.split('\n').entries()) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); }
    catch (error) { throw new Error(`Corrupt DeepSeek Harness JSONL record at line ${index + 1}`, { cause: error }); }
  }
  const value = rows.shift();
  if (!record(value) || value.type !== 'session' || value.version !== version || typeof value.id !== 'string' || !value.id
    || !Number.isSafeInteger(value.createdAt) || !Number.isFinite(new Date(value.createdAt as number).getTime())
    || (value.cwd !== undefined && typeof value.cwd !== 'string') || (value.isSeeded !== undefined && typeof value.isSeeded !== 'boolean')) {
    throw new Error('Invalid or incomplete DeepSeek Harness V4 session header');
  }
  const events: DeepseekEvent[] = [];
  let previousSeq = -1;
  let inheritedEventCount = 0;
  for (const row of rows) {
    if (!record(row) || typeof row.type !== 'string' || !Number.isSafeInteger(row.seq) || (row.seq as number) <= previousSeq
      || !Number.isSafeInteger(row.time) || !Number.isFinite(new Date(row.time as number).getTime()) || !record(row.data)) {
      throw new Error('Invalid DeepSeek Harness event envelope or non-monotonic sequence');
    }
    const event = row as DeepseekEvent;
    previousSeq = event.seq;
    events.push(event);
    if (event.type === 'session/end-seed' && event.data.inherited === true) inheritedEventCount = events.length;
  }
  if (value.isSeeded === true && inheritedEventCount === 0) throw new Error('Seeded DeepSeek Harness session is missing its inherited history boundary');
  return { header: value as unknown as DeepseekHeader, events, inheritedEventCount };
}
