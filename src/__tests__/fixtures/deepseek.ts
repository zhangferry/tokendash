import { spawnSync } from 'node:child_process';
import * as zlib from 'node:zlib';
import type { DeepseekEvent, DeepseekHeader } from '../../server/deepseekSessionLog.js';

export const deepseekHeader: DeepseekHeader = {
  type: 'session', version: 4, id: 'session-fixture', cwd: '/work/deepseek-demo',
  createdAt: Date.parse('2026-11-04T10:00:00Z'), isSeeded: false,
};
export function deepseekEvent(seq: number, type: string, data: Record<string, any>, time = deepseekHeader.createdAt + seq * 1_000): DeepseekEvent {
  return { type, seq, time, data };
}
export function deepseekUsage(input = 100, output = 20, cacheRead = 200, cacheWrite = 0) {
  return { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, totalTokens: input + output + cacheRead + cacheWrite };
}
export function deepseekMessage(seq: number, usage = deepseekUsage(), options: { turn?: number; step?: number; model?: string; provider?: string; time?: number } = {}): DeepseekEvent {
  return deepseekEvent(seq, 'assistant/message', {
    turn: options.turn ?? 1, step: options.step ?? seq,
    message: { role: 'assistant', id: `message-${seq}`, source: { kind: 'model', provider: options.provider ?? 'deepseek-account', model: options.model ?? 'deepseek-flash' }, content: [{ type: 'text', text: 'Synthetic fixture answer.' }] },
    usage, stream: [{ type: 'chunk', time: options.time ?? deepseekHeader.createdAt, chunk: { type: 'usage', usage } }],
  }, options.time);
}
export function deepseekJsonl(rows: unknown[]): string { return rows.map(row => JSON.stringify(row)).join('\n') + '\n'; }

const compress = (zlib as unknown as { zstdCompressSync?: (buffer: Buffer, options?: unknown) => Buffer }).zstdCompressSync;
export const hasSystemZstd = spawnSync('zstd', ['--version'], { encoding: 'utf8' }).status === 0;
export const hasZstdEncoder = Boolean(compress) || hasSystemZstd;
export function deepseekZstdFrames(rows: unknown[]): Buffer {
  return Buffer.concat(rows.map(row => {
    const bytes = Buffer.from(deepseekJsonl([row]));
    if (compress) return compress(bytes, { params: { [(zlib.constants as unknown as Record<string, number>).ZSTD_c_checksumFlag]: 1 } });
    const result = spawnSync('zstd', ['-q', '-c', '--check'], { input: bytes, maxBuffer: 32 * 1024 * 1024 });
    if (result.status !== 0) throw new Error('Fixture requires a Zstandard encoder');
    return result.stdout;
  }));
}
