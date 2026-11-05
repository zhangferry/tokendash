import { readDeepseekSessionLog } from './deepseekSessionLog.js';
import type { SessionStatus } from '../shared/types.js';
import type { TranscriptMessage } from './sessionTranscripts.js';

interface SettlementUsage {
  seq: number;
  timestamp: string;
}

export interface DeepseekTranscript {
  messages: TranscriptMessage[];
  status: SessionStatus;
  endedAt?: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Keep durable visible content, without duplicating tool calls embedded in assistant messages. */
function content(value: unknown): unknown {
  if (!Array.isArray(value)) return typeof value === 'string' ? value : [];
  return value.flatMap<unknown>(item => {
    const part = record(item);
    if (part.type === 'text') return [{ type: 'text', text: part.text }];
    if (part.type === 'reasoning') return [{ type: 'thinking', thinking: part.text }];
    if (part.type === 'image' || part.type === 'file') return [{ type: 'text', text: `[${part.type === 'image' ? 'Image' : 'File'} attachment]` }];
    return [];
  });
}

function argumentsObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return record(value);
  try { return record(JSON.parse(value)); } catch { return { arguments: value }; }
}

/**
 * V4 settlements may replace an earlier sample from the same request. Mirror
 * that boundary for the transcript, while retaining a distinct failed attempt
 * when llm/retry-started begins another request at the same turn/step.
 */
export function readDeepseekTranscript(file: string, usage: SettlementUsage[] = []): DeepseekTranscript {
  const log = readDeepseekSessionLog(file);
  const messages: TranscriptMessage[] = [];
  const slotsBySeq = new Map<number, number>();
  const names = new Map<string, string>();
  let routeModel: string | undefined;
  let last: { turn: unknown; step: unknown; index: number } | undefined;
  let status: SessionStatus = 'unknown';
  let endedAt: string | undefined;
  for (const [index, event] of log.events.entries()) {
    const data = record(event.data);
    if (event.type === 'request/header') {
      const config = record(record(data.header).config);
      routeModel = typeof config.model === 'string' ? config.model : undefined;
    }
    // Restore route metadata from inherited history, but never index its calls or messages twice.
    if (index < log.inheritedEventCount) continue;
    const timestamp = new Date(event.time).toISOString();
    endedAt = timestamp;
    const base = { id: String(event.seq), sessionId: log.header.id, project: log.header.cwd, timestamp };
    if (event.type === 'turn/start') status = 'unknown';
    if (event.type === 'turn/end') {
      const reason = record(data.reason).kind;
      status = reason === 'completed' ? 'complete'
        : ['cancelled', 'failed', 'error', 'interrupted', 'aborted', 'blocked', 'max-tokens', 'forked'].includes(String(reason)) ? 'interrupted' : 'unknown';
    }
    if (event.type === 'llm/retry-started') {
      if (last && last.turn === data.turn && last.step === data.step) last = undefined;
      continue;
    }
    if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
      const message = record(data.message);
      const source = record(message.source);
      const model = typeof source.model === 'string' ? source.model : routeModel;
      const value: TranscriptMessage = {
        ...base, role: 'assistant', model, content: content(message.content), sourceSeq: event.seq,
        ...(event.type === 'assistant/attempt' || data.interrupted === true ? { error: true } : {}),
      };
      if (data.interrupted === true) status = 'interrupted';
      const slot = last && last.turn === data.turn && last.step === data.step ? last.index : messages.length;
      if (slot === messages.length) messages.push(value);
      else messages[slot] = value;
      slotsBySeq.set(event.seq, slot);
      last = { turn: data.turn, step: data.step, index: slot };
      continue;
    }
    if (event.type === 'user/message') {
      const kind = record(data.source).kind;
      // Harness uses role=user for clock, skills, jobs and approval context too.
      // Those are runtime inputs, not additional conversational user turns.
      const role = kind === undefined || kind === 'user' ? 'user' : 'runtime';
      messages.push({ ...base, role, content: content(data.content) });
    }
    if (event.type === 'system/message' || event.type === 'developer/message') {
      const message = record(data.message);
      messages.push({ ...base, role: event.type === 'system/message' ? 'system' : 'developer', content: content(message.content) });
    }
    if (event.type === 'tool/call') {
      const callId = String(data.callId);
      const name = String(data.name);
      names.set(callId, name);
      messages.push({ ...base, role: 'tool', content: [{ type: 'toolCall', id: callId, name, arguments: argumentsObject(data.arguments) }] });
    }
    if (event.type === 'tool/result') {
      const message = record(data.message);
      const callId = typeof message.toolCallId === 'string' ? message.toolCallId : undefined;
      messages.push({ ...base, role: 'toolResult', callId, toolName: callId ? names.get(callId) : undefined, content: content(message.content), ...(typeof message.isError === 'boolean' ? { success: !message.isError } : {}) });
    }
  }
  // A replacement without fresh usage keeps the last reported sample. Associate
  // it with its surviving attempt by seq rather than assuming timestamps unique.
  for (const sample of usage) {
    const slot = slotsBySeq.get(sample.seq);
    if (slot !== undefined) messages[slot] = { ...messages[slot], sourceSeq: sample.seq, timestamp: sample.timestamp };
  }
  return { messages: messages.sort((a, b) => a.timestamp.localeCompare(b.timestamp)), status, endedAt };
}
