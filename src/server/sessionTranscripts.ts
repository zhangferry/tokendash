import { openSqliteReader } from './sqliteReader.js';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface TranscriptMessage {
  id: string;
  sessionId: string;
  project?: string;
  timestamp: string;
  role: string;
  model?: string;
  content: unknown;
  callId?: string;
  toolName?: string;
  success?: boolean;
  error?: boolean;
  /** Source settlement sequence, used when timestamps are shared by multiple requests. */
  sourceSeq?: number;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

export function readPiTranscript(file: string): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n').filter(line => line.trim())) {
    let row: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      row = parsed as Record<string, unknown>;
    } catch {
      // A live JSONL writer may leave the final record incomplete until its next write.
      continue;
    }
    if (typeof row.timestamp !== 'string' && typeof row.timestamp !== 'number') continue;
    const date = new Date(row.timestamp);
    if (!Number.isFinite(date.getTime())) continue;
    const timestamp = date.toISOString();
    if (row.type !== 'message') {
      if (row.type === 'compaction' || row.type === 'branch_summary') messages.push({ id: String(row.id), sessionId: '', timestamp, role: 'runtime', content: typeof row.summary === 'string' ? row.summary : JSON.stringify({ type: row.type, details: row.details }) });
      if (row.type === 'model_change') messages.push({ id: String(row.id), sessionId: '', timestamp, role: 'runtime', content: JSON.stringify({ type: row.type, model: row.modelId }) });
      continue;
    }
    const message = record(row.message);
    messages.push({ id: String(row.id), sessionId: '', timestamp, role: String(message.role), model: typeof message.model === 'string' ? message.model : undefined, content: message.content, callId: typeof message.toolCallId === 'string' ? message.toolCallId : undefined, toolName: typeof message.toolName === 'string' ? message.toolName : undefined, success: typeof message.isError === 'boolean' ? !message.isError : undefined, error: message.stopReason === 'error' || message.stopReason === 'aborted' });
  }
  return messages;
}

export function readOpenCodeTranscripts(): TranscriptMessage[] {
  const path = join(homedir(), '.local', 'share', 'opencode', 'opencode.db');
  if (!existsSync(path)) return [];
  const db = openSqliteReader(path);
  try {
    const tables = new Set(db.all("SELECT name FROM sqlite_master WHERE type='table'").map(row => String(row.name)));
    let rows: Record<string, unknown>[];
    const parts = new Map<string, unknown[]>();
    if (tables.has('session_message')) {
      rows = db.all('SELECT m.*, s.directory FROM session_message m LEFT JOIN session_v2 s ON s.id=m.session_id ORDER BY m.time_created, m.seq');
    } else if (tables.has('message')) {
      rows = db.all('SELECT * FROM message ORDER BY rowid');
      if (tables.has('part')) for (const row of db.all('SELECT * FROM part ORDER BY rowid')) {
        const key = String(row.message_id);
        if (!parts.has(key)) parts.set(key, []);
        parts.get(key)!.push(JSON.parse(String(row.data)));
      }
    } else throw new Error('The OpenCode database does not contain a message table.');
    return rows.map(row => {
      const data = JSON.parse(String(row.data)) as Record<string, unknown>;
      const time = record(data.time);
      const model = record(data.model);
      const raw = data.content ?? data.text ?? parts.get(String(row.id)) ?? [];
      let content = Array.isArray(raw) ? raw.flatMap(value => {
        const part = record(value);
        if (part.type === 'reasoning') return [{ type: 'thinking', thinking: part.text }];
        if (part.type !== 'tool') return [part];
        const state = record(part.state);
        const name = part.name ?? part.tool;
        return [{ type: 'toolCall', id: part.id ?? part.callID, name, arguments: state.input, state }, ...(state.status === 'completed' || state.status === 'error' ? [{ type: 'toolResult', toolCallId: part.id ?? part.callID, toolName: name, content: state.content ?? state.output ?? state.error, success: state.status === 'completed' }] : [])];
      }) : raw;
      const type = String(row.type ?? data.role);
      let role = type;
      let callId: string | undefined;
      let success: boolean | undefined;
      if (type === 'shell') {
        role = 'tool';
        const output = record(data.output);
        content = [{ type: 'toolCall', id: data.shellID, name: 'shell', arguments: { command: data.command } }, ...(data.exit !== undefined ? [{ type: 'toolResult', toolCallId: data.shellID, toolName: 'shell', content: output.output, success: data.exit === 0 }] : [])];
      } else if (type === 'synthetic') {
        const metadata = record(data.metadata);
        role = metadata.shellID ? 'toolResult' : 'runtime';
        callId = typeof metadata.shellID === 'string' ? metadata.shellID : undefined;
        success = typeof metadata.exit === 'number' ? metadata.exit === 0 : undefined;
      } else if (['compaction', 'idle', 'location-switched', 'model-switched'].includes(type)) {
        role = 'runtime';
        content = JSON.stringify({ type, ...(data.outcome ? { outcome: data.outcome } : {}), ...(data.status ? { status: data.status } : {}), ...(data.reason ? { reason: data.reason } : {}), ...(data.error ? { error: data.error } : {}), ...(data.location ? { location: data.location } : {}), ...(data.model ? { model: data.model } : {}) });
      }
      return { id: String(row.id), sessionId: String(row.session_id ?? data.sessionID), project: String(row.directory ?? record(data.path).cwd ?? ''), timestamp: new Date(Number(time.created ?? row.time_created)).toISOString(), role, model: typeof data.modelID === 'string' ? data.modelID : typeof model.id === 'string' ? model.id : undefined, content, callId, success, error: Boolean(data.error) || data.outcome === 'error' || data.outcome === 'interrupted' };
    });
  } finally {
    db.close();
  }
}
