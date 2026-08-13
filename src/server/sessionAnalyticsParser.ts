import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import type {
  SessionAnalyticsCapabilities,
  SessionAnalyticsResponse,
  SessionDetail,
  SessionDistributionEntry,
  SessionEvent,
  SessionStatus,
  SessionSummary,
} from '../shared/types.js';
import { calculateCost as calculateClaudeCost, extractProjectName } from './claudeJsonlParser.js';
import { parseAllSessions, scanCodexSessions, type ParsedSession } from './codexParser.js';
import { calculateCost as calculateCodexCost } from './codexPricing.js';

export type SessionAnalyticsRange = 'today' | '7d' | '30d' | '60d' | 'all';

export interface SessionAnalyticsFilters {
  project?: string;
  range?: SessionAnalyticsRange;
  model?: string;
  status?: SessionStatus;
  query?: string;
  cursor?: string;
  limit?: number;
}

export interface SessionAnalyticsIndexedSession {
  summary: SessionSummary;
  events: SessionEvent[];
  /** Local-only source pointer used to hydrate one opened Claude session. */
  sourceFile?: string;
}

interface SessionSource {
  sessions: SessionAnalyticsIndexedSession[];
  capabilities: SessionAnalyticsCapabilities;
  indexedAt: string;
}

const NO_SESSION_CAPABILITIES: SessionAnalyticsCapabilities = {
  userTurns: false,
  skills: false,
  tools: false,
  toolResults: false,
  contentPreview: false,
};

const sourceCache = new Map<string, SessionSource>();

function validTimestamp(timestamp: unknown): timestamp is string {
  return typeof timestamp === 'string' && Number.isFinite(Date.parse(timestamp));
}

const TITLE_LIMIT = 96;
const VALUE_LIMIT = 120;
const CONTENT_PREVIEW_LIMIT = 280;
const CONTENT_LIMIT = 12_000;
const INPUT_CONTEXT_LIMIT = 64_000;
const SENSITIVE_KEY = /(?:api[_-]?key|access[_-]?token|auth(?:orization)?|password|passwd|secret|client[_-]?secret|cookie|credential|private[_-]?key)/i;
const BODY_KEY = /(?:body|content|stdout|stderr|output|text|prompt|message|transcript)/i;

function compactText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Remove common secret forms before any source-derived text reaches an API response. */
function redactSecrets(value: string): string {
  return value
    .replace(/\b(?:sk|pk|rk)_[A-Za-z0-9_-]{12,}\b/g, '[redacted]')
    .replace(/\b(?:ghp|gho|github_pat)_[A-Za-z0-9_-]{12,}\b/gi, '[redacted]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[redacted]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted private key]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/(<(api[_-]?key|access[_-]?token|auth(?:orization)?|password|passwd|secret|client[_-]?secret|cookie|credential|private[_-]?key)>)[\s\S]*?(<\/\2>)/gi, '$1[redacted]$3')
    .replace(/((?:["']?)(?:api[_-]?key|access[_-]?token|auth(?:orization)?|password|passwd|secret|client[_-]?secret|cookie|credential|private[_-]?key)(?:["']?)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[redacted]')
    .replace(/\/Users\/[^/\s<>"']+/g, '/Users/[user]')
    .replace(/\/home\/[^/\s<>"']+/g, '/home/[user]');
}

function redactText(value: string): string {
  return redactSecrets(compactText(value));
}

function redactSourceText(value: string): string {
  const normalized = value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .trim();
  return redactSecrets(normalized);
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, Math.max(1, limit - 1)).trimEnd()}…` : value;
}

function sourceTextItems(content: unknown): string[] {
  if (typeof content === 'string') return content.trim() ? [content] : [];
  if (!Array.isArray(content)) return [];
  return content
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .filter(item => item.type === 'text' || item.type === 'input_text')
    .map(item => typeof item.text === 'string' ? item.text : '')
    .filter(Boolean);
}

const CONTEXT_SOURCES: Array<{ pattern: RegExp; label: string; runtime: boolean }> = [
  { pattern: /^<app-context>/i, label: 'App context', runtime: true },
  { pattern: /^<permissions(?:\s+instructions)?>/i, label: 'Permissions', runtime: true },
  { pattern: /^<skills_instructions>/i, label: 'Skills', runtime: true },
  { pattern: /^<environment_context>/i, label: 'Environment', runtime: true },
  { pattern: /^<recommended_plugins>/i, label: 'Recommended plugins', runtime: true },
  { pattern: /^<collaboration_mode>/i, label: 'Collaboration mode', runtime: true },
  { pattern: /^<apps_instructions>/i, label: 'App instructions', runtime: true },
  { pattern: /^<plugins_instructions>/i, label: 'Plugin instructions', runtime: true },
  { pattern: /^<multi_agent_mode>/i, label: 'Multi-agent mode', runtime: true },
  { pattern: /^#\s*AGENTS\.md/i, label: 'AGENTS.md instructions', runtime: true },
];

function contextSource(text: string) {
  const value = text.trimStart();
  return CONTEXT_SOURCES.find(source => source.pattern.test(value));
}

function isRuntimeContext(text: string): boolean {
  return contextSource(text)?.runtime === true;
}

function textFromContent(content: unknown): string | undefined {
  const texts = sourceTextItems(content);
  // Codex records environment and agent policy as role=user input_text blocks.
  // Those are not useful session titles and can be much larger than the actual request.
  const userAuthored = texts.filter(text => !isRuntimeContext(text));
  const text = userAuthored.join(' ');
  return compactText(text) || undefined;
}

function contextLabel(text: string, kind: NonNullable<SessionEvent['inputKind']>): string {
  return contextSource(text)?.label || (kind === 'system' ? 'System prompt' : kind === 'developer' ? 'Developer instructions' : 'Runtime context');
}

function inputContextEvent(text: string, kind: NonNullable<SessionEvent['inputKind']>, timestamp: string, index: number): SessionEvent | undefined {
  const source = redactSourceText(text);
  const content = truncate(source, INPUT_CONTEXT_LIMIT);
  if (!content) return undefined;
  const label = contextLabel(content, kind);
  return {
    id: `context-${index}`,
    timestamp,
    type: 'input_context',
    inputKind: kind,
    contextLabel: label,
    summary: `${kind === 'system' ? 'System' : kind === 'developer' ? 'Developer' : 'Runtime'} input · ${label}`,
    ...retainedContentFields(content),
    ...(source.length > INPUT_CONTEXT_LIMIT ? { contentTruncated: true } : {}),
  };
}

function promptSummary(content: unknown): Pick<SessionSummary, 'title'> | undefined {
  const text = textFromContent(content);
  if (!text) return undefined;
  const safe = redactText(text);
  if (!safe) return undefined;
  const title = truncate(safe, TITLE_LIMIT);
  return { title };
}

function safeContent(content: unknown): string | undefined {
  const text = textFromContent(content);
  if (!text) return undefined;
  const safe = redactText(text);
  return safe ? truncate(safe, CONTENT_LIMIT) : undefined;
}

function textContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && item.type === 'text')
    .map(item => typeof item.text === 'string' ? item.text : '')
    .filter(Boolean)
    .join(' ');
  const safe = redactText(text);
  return safe ? truncate(safe, CONTENT_LIMIT) : undefined;
}

/** Claude records private model reasoning in a `thinking` block, separate from text replies. */
function thinkingContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && item.type === 'thinking')
    .map(item => typeof item.thinking === 'string' ? item.thinking : typeof item.text === 'string' ? item.text : '')
    .filter(Boolean)
    .join(' ');
  const safe = redactText(text);
  return safe ? truncate(safe, CONTENT_LIMIT) : undefined;
}

function contentFields(content: string | undefined): Pick<SessionEvent, 'contentPreview' | 'contentAvailable' | 'content'> {
  if (!content) return { contentAvailable: false };
  return {
    contentPreview: truncate(content, CONTENT_PREVIEW_LIMIT),
    contentAvailable: true,
  };
}

/** Codex event messages already contain locally-readable user/agent text. */
function retainedContentFields(content: string | undefined): Pick<SessionEvent, 'contentPreview' | 'contentAvailable' | 'content'> {
  if (!content) return { contentAvailable: false };
  return { ...contentFields(content), content };
}

function valueSummary(value: unknown, depth = 0): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return `“${truncate(redactText(value), VALUE_LIMIT)}”`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    if (depth >= 1) return `[${value.length} items]`;
    return `[${value.slice(0, 3).map(item => valueSummary(item, depth + 1)).join(', ')}${value.length > 3 ? ', …' : ''}]`;
  }
  if (typeof value !== 'object') return typeof value;
  if (depth >= 2) return '{…}';
  const entries = Object.entries(value as Record<string, unknown>);
  return `{ ${entries.slice(0, 5).map(([key, item]) => {
    if (SENSITIVE_KEY.test(key)) return `${key}: [redacted]`;
    if (BODY_KEY.test(key)) return `${key}: [${typeof item === 'string' ? `${item.length} chars` : 'content withheld'}]`;
    return `${key}: ${valueSummary(item, depth + 1)}`;
  }).join(', ')}${entries.length > 5 ? ', …' : ''} }`;
}

function parameterSummary(input: unknown): string | undefined {
  if (input === undefined || input === null) return undefined;
  return `Parameters ${truncate(valueSummary(input), 360)}`;
}

function resultSummary(output: unknown): string | undefined {
  if (output === undefined || output === null) return undefined;
  let value = output;
  if (typeof output === 'string') {
    try { value = JSON.parse(output); } catch { return `Text result (${output.length.toLocaleString()} chars; body withheld)`; }
  }
  if (typeof value !== 'object' || Array.isArray(value)) return `Result ${truncate(valueSummary(value), 180)}`;
  const entries = Object.entries(value as Record<string, unknown>);
  const parts = entries.slice(0, 6).map(([key, item]) => {
    if (SENSITIVE_KEY.test(key)) return `${key}: [redacted]`;
    if (BODY_KEY.test(key)) return `${key}: ${typeof item === 'string' ? `${item.length.toLocaleString()} chars (withheld)` : 'withheld'}`;
    return `${key}: ${valueSummary(item)}`;
  });
  return `Result { ${parts.join(', ')}${entries.length > 6 ? ', …' : ''} }`;
}

function toolInvocationName(name: string, input: unknown): { isSkill: boolean; name: string } {
  const isSkill = name.toLowerCase() === 'skill';
  const skillName = isSkill && input && typeof input === 'object' && typeof (input as Record<string, unknown>).skill === 'string'
    ? (input as Record<string, unknown>).skill as string
    : name;
  return { isSkill, name: skillName };
}

function serializedToolInput(input: unknown): string {
  if (typeof input === 'string') return input;
  try { return JSON.stringify(input); } catch { return ''; }
}

function inferredSkillNames(toolName: string, input: unknown): string[] {
  const text = serializedToolInput(input);
  if (!text || !/[/\\]skills[/\\]/i.test(text)) return [];
  const directReader = /^(read|read_file)$/i.test(toolName);
  const commandReader = /^(exec|exec_command|bash)$/i.test(toolName)
    && /(?:^|[\s"';&|`])(?:cat|sed|head|tail|less|more)\b/i.test(text);
  if (!directReader && !commandReader) return [];
  const names = new Set<string>();
  for (const match of text.matchAll(/[/\\]skills[/\\](?:[^\s"'`/\\]+[/\\])*([^\s"'`/\\]+)[/\\]SKILL\.md\b/gi)) {
    if (match[1] && match[1] !== '.system') names.add(match[1]);
  }
  return [...names];
}

function sessionDescription(userTurns: number, toolCalls: number, skillCalls: number): string | undefined {
  const parts = [
    userTurns ? `${userTurns} user turn${userTurns === 1 ? '' : 's'}` : undefined,
    toolCalls ? `${toolCalls} tool call${toolCalls === 1 ? '' : 's'}` : undefined,
    skillCalls ? `${skillCalls} Skill call${skillCalls === 1 ? '' : 's'}` : undefined,
  ].filter((part): part is string => Boolean(part));
  return parts.length ? parts.join(' · ') : undefined;
}

function projectName(cwd: string): string | undefined {
  const name = cwd.replace(/\/+$/, '').split('/').pop();
  return name || undefined;
}

function sourceSignature(paths: string[]): string {
  return paths.map(path => {
    try {
      const stat = statSync(path);
      return `${path}:${stat.size}:${stat.mtimeMs}`;
    } catch {
      return `${path}:unavailable`;
    }
  }).join('|');
}

function findJsonlFiles(directory: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) files.push(...findJsonlFiles(path));
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path);
    }
  } catch {
    // A session source may disappear while it is being enumerated.
  }
  return files;
}

function claudeFiles(): string[] {
  const claudeHome = process.env.CLAUDE_HOME || join(homedir(), '.claude');
  return findJsonlFiles(join(claudeHome, 'projects')).sort();
}

/** A revision is source metadata only; neither contents nor paths are sent to clients. */
export function getSessionAnalyticsSourceRevision(agent: string): string {
  if (agent === 'codex') return sourceSignature(scanCodexSessions());
  if (agent === 'claude') return sourceSignature(claudeFiles());
  return 'unsupported';
}

interface CodexTranscriptMetadata {
  title?: string;
  description?: string;
  userTurns: number;
  toolCalls: number;
  skillCalls: number;
  events: SessionEvent[];
}

function outputSuccess(output: unknown): boolean | undefined {
  let value = output;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return undefined; }
  }
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.success === 'boolean') return record.success;
  if (typeof record.is_error === 'boolean') return !record.is_error;
  const exitCode = record.exit_code ?? record.exitCode;
  return typeof exitCode === 'number' ? exitCode === 0 : undefined;
}

function codexTranscriptMetadata(sessionId: string): CodexTranscriptMetadata {
  const filepath = scanCodexSessions().find(path => basename(path).includes(sessionId));
  if (!filepath) return { userTurns: 0, toolCalls: 0, skillCalls: 0, events: [] };
  let raw = '';
  try { raw = readFileSync(filepath, 'utf8'); } catch { return { userTurns: 0, toolCalls: 0, skillCalls: 0, events: [] }; }
  return parseCodexTranscriptMetadata(raw);
}

/** Exported for parser fixtures: canonical event_msg records beat synthetic role=user envelopes. */
export function parseCodexTranscriptMetadata(raw: string): CodexTranscriptMetadata {
  const initial: CodexTranscriptMetadata = { userTurns: 0, toolCalls: 0, skillCalls: 0, events: [] };
  const records: Record<string, unknown>[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line) as Record<string, unknown>); } catch { /* ignore malformed transcript rows */ }
  }
  // Desktop Codex writes a canonical event_msg for an actual human turn. It
  // intentionally excludes the role=user envelope containing AGENTS.md and
  // other runtime context, which must never become a user request in the UI.
  const hasCanonicalUserMessages = records.some(record => {
    const payload = record.payload as Record<string, unknown> | undefined;
    return record.type === 'event_msg' && payload?.type === 'user_message' && typeof payload.message === 'string';
  });
  const calls = new Map<string, { name: string; isSkill: boolean }>();
  let taskIndex = -1;
  const inferredByTask = new Map<number, Set<string>>();
  const inferredEventsByTask = new Map<number, SessionEvent[]>();
  const explicitSkillTasks = new Set<number>();
  for (const record of records) {
    if (!validTimestamp(record.timestamp)) continue;
    const payload = record.payload;
    if (!payload || typeof payload !== 'object') continue;
    const item = payload as Record<string, unknown>;
    if (record.type === 'event_msg') {
      if (item.type === 'user_message' && typeof item.message === 'string') {
        const input = safeContent(item.message);
        if (!input) continue;
        initial.userTurns++;
        taskIndex++;
        const prompt = promptSummary(item.message);
        if (prompt && !initial.title) Object.assign(initial, prompt);
        initial.events.push({
          id: `user-${initial.events.length + 1}`,
          timestamp: record.timestamp,
          type: 'user_message',
          summary: 'User request',
          ...retainedContentFields(input),
        });
      }
      if (item.type === 'agent_message' && typeof item.message === 'string') {
        const response = safeContent(item.message);
        if (!response) continue;
        const phase = item.phase === 'final_answer' ? 'final_answer' : item.phase === 'commentary' ? 'commentary' : undefined;
        initial.events.push({
          id: `assistant-${initial.events.length + 1}`,
          timestamp: record.timestamp,
          type: 'assistant_message',
          summary: phase === 'final_answer' ? 'Final response' : 'Agent update',
          ...(phase ? { phase } : {}),
          ...retainedContentFields(response),
        });
      }
      continue;
    }
    if (record.type !== 'response_item') continue;
    if (item.type === 'message' && (item.role === 'system' || item.role === 'developer')) {
      const kind = item.role;
      for (const text of sourceTextItems(item.content)) {
        const context = inputContextEvent(text, kind, record.timestamp, initial.events.length + 1);
        if (context) initial.events.push(context);
      }
      continue;
    }
    if (item.type === 'message' && item.role === 'user') {
      for (const text of sourceTextItems(item.content).filter(isRuntimeContext)) {
        const context = inputContextEvent(text, 'runtime', record.timestamp, initial.events.length + 1);
        if (context) initial.events.push(context);
      }
      if (hasCanonicalUserMessages) continue;
      const input = safeContent(item.content);
      if (!input) continue;
      initial.userTurns++;
      taskIndex++;
      const prompt = promptSummary(item.content);
      if (prompt && !initial.title) Object.assign(initial, prompt);
      initial.events.push({
        id: `user-${initial.events.length + 1}`,
        timestamp: record.timestamp,
        type: 'user_message',
        summary: 'User request',
        ...retainedContentFields(input),
      });
      continue;
    }
    if ((item.type === 'function_call' || item.type === 'custom_tool_call') && typeof item.name === 'string') {
      let input: unknown = item.type === 'custom_tool_call' ? item.input : item.arguments;
      if (typeof input === 'string') {
        try { input = JSON.parse(input); } catch { /* preserve a bounded raw argument summary */ }
      }
      const invocation = toolInvocationName(item.name, input);
      if (invocation.isSkill) {
        if (!explicitSkillTasks.has(taskIndex)) {
          explicitSkillTasks.add(taskIndex);
          const inferredEvents = inferredEventsByTask.get(taskIndex) || [];
          if (inferredEvents.length) {
            const inferredIds = new Set(inferredEvents.map(event => event.id));
            initial.events = initial.events.filter(event => !inferredIds.has(event.id));
            initial.skillCalls -= inferredEvents.length;
          }
        }
        initial.skillCalls++;
      } else initial.toolCalls++;
      if (typeof item.call_id === 'string') calls.set(item.call_id, invocation);
      if (!invocation.isSkill && !explicitSkillTasks.has(taskIndex)) {
        const taskSkills = inferredByTask.get(taskIndex) || new Set<string>();
        inferredByTask.set(taskIndex, taskSkills);
        for (const skillName of inferredSkillNames(item.name, input)) {
          if (taskSkills.has(skillName)) continue;
          taskSkills.add(skillName);
          initial.skillCalls++;
          const inferredEvent: SessionEvent = {
            id: `skill-inferred-${initial.events.length + 1}`,
            timestamp: record.timestamp,
            type: 'skill_call',
            skillName,
            skillOrigin: 'inferred',
            summary: `Skill ${skillName} inferred from process`,
            parameterSummary: `Inferred from ${item.name} reading ${skillName}/SKILL.md`,
            contentAvailable: false,
          };
          initial.events.push(inferredEvent);
          const taskEvents = inferredEventsByTask.get(taskIndex) || [];
          taskEvents.push(inferredEvent);
          inferredEventsByTask.set(taskIndex, taskEvents);
        }
      }
      initial.events.push({
        id: `${invocation.isSkill ? 'skill' : 'tool'}-${initial.events.length + 1}`,
        ...(typeof item.call_id === 'string' ? { callId: item.call_id } : {}),
        timestamp: record.timestamp,
        type: invocation.isSkill ? 'skill_call' : 'tool_call',
        ...(invocation.isSkill ? { skillName: invocation.name } : { toolName: invocation.name }),
        ...(invocation.isSkill ? { skillOrigin: 'explicit' as const } : {}),
        summary: `${invocation.isSkill ? 'Skill' : 'Tool'} ${invocation.name} called`,
        ...(parameterSummary(input) ? { parameterSummary: parameterSummary(input) } : {}),
        contentAvailable: false,
      });
      continue;
    }
    if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
      const invocation = typeof item.call_id === 'string' ? calls.get(item.call_id) : undefined;
      const success = outputSuccess(item.output);
      initial.events.push({
        id: `tool-result-${initial.events.length + 1}`,
        ...(typeof item.call_id === 'string' ? { callId: item.call_id } : {}),
        timestamp: record.timestamp,
        type: 'tool_result',
        ...(invocation?.isSkill ? { skillName: invocation.name } : invocation ? { toolName: invocation.name } : {}),
        ...(success === undefined ? {} : { success }),
        summary: success === false ? 'Tool result failed' : success ? 'Tool result completed' : 'Tool result received',
        ...(resultSummary(item.output) ? { resultSummary: resultSummary(item.output) } : {}),
        contentAvailable: false,
      });
    }
  }
  return initial;
}

function codexSessionToIndexed(session: ParsedSession): SessionAnalyticsIndexedSession {
  const transcript = codexTranscriptMetadata(session.id);
  const events = session.tokenEvents.map((event, index): SessionEvent => {
    const model = event.model || session.model || 'unknown';
    const cost = calculateCodexCost(event, new Set([model]));
    return {
      id: `llm-${index + 1}`,
      timestamp: event.timestamp,
      type: 'llm_call',
      model,
      contentAvailable: false,
      usage: {
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        cacheReadTokens: event.cachedInputTokens,
        totalTokens: event.totalTokens,
        cost,
      },
    };
  });
  const startedAt = validTimestamp(session.createdAt)
    ? session.createdAt
    : events[0]?.timestamp || new Date(0).toISOString();
  events.push(...transcript.events);
  const endedAt = [...events].sort((left, right) => left.timestamp.localeCompare(right.timestamp)).at(-1)?.timestamp;
  const start = Date.parse(startedAt);
  const end = endedAt ? Date.parse(endedAt) : Number.NaN;
  const durationMs = Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : undefined;
  const models = [...new Set(events.map(event => event.model).filter((model): model is string => Boolean(model)))];

  return {
    summary: {
      id: session.id,
      agent: 'codex',
      project: projectName(session.cwd),
      ...(transcript.title ? { title: transcript.title } : {}),
      ...(sessionDescription(transcript.userTurns, transcript.toolCalls, transcript.skillCalls)
        ? { description: sessionDescription(transcript.userTurns, transcript.toolCalls, transcript.skillCalls) }
        : {}),
      startedAt,
      ...(endedAt ? { endedAt } : {}),
      // Codex transcripts do not carry a stable completion marker.
      status: 'unknown',
      models,
      llmCallCount: session.tokenEvents.length,
      toolCallCount: transcript.toolCalls,
      ...(transcript.userTurns ? { userTurnCount: transcript.userTurns } : {}),
      durationMs,
      totalTokens: events.reduce((total, event) => total + (event.usage?.totalTokens ?? 0), 0),
      totalCost: events.reduce((total, event) => total + (event.usage?.cost ?? 0), 0),
    },
    events: events.sort((left, right) => left.timestamp.localeCompare(right.timestamp)),
  };
}

interface MutableClaudeSession {
  id: string;
  sourceFile: string;
  project?: string;
  startedAt?: string;
  endedAt?: string;
  models: Set<string>;
  events: SessionEvent[];
  userTurns: number;
  toolCalls: number;
  skillCalls: number;
  totalTokens: number;
  totalCost: number;
  hasSkill: boolean;
  hasToolResultSemantics: boolean;
  title?: string;
  description?: string;
}

function earlierTimestamp(current: string | undefined, next: string): string {
  return !current || Date.parse(next) < Date.parse(current) ? next : current;
}

function laterTimestamp(current: string | undefined, next: string): string {
  return !current || Date.parse(next) > Date.parse(current) ? next : current;
}

function mutableClaudeSession(map: Map<string, MutableClaudeSession>, id: string, sourceFile: string, project?: string): MutableClaudeSession {
  const existing = map.get(id);
  if (existing) return existing;
  const created: MutableClaudeSession = {
    id,
    sourceFile,
    project,
    models: new Set(),
    events: [],
    userTurns: 0,
    toolCalls: 0,
    skillCalls: 0,
    totalTokens: 0,
    totalCost: 0,
    hasSkill: false,
    hasToolResultSemantics: false,
  };
  map.set(id, created);
  return created;
}

function claudeSessionsFromFile(filepath: string): MutableClaudeSession[] {
  let raw = '';
  try {
    raw = readFileSync(filepath, 'utf8');
  } catch {
    return [];
  }

  const projectDir = basename(join(filepath, '..'));
  const project = extractProjectName(projectDir);
  const fallbackId = basename(filepath, '.jsonl');
  const sessions = new Map<string, MutableClaudeSession>();
  const toolNames = new Map<string, { name: string; isSkill: boolean }>();

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const timestamp = entry.timestamp;
    if (!validTimestamp(timestamp)) continue;
    const id = typeof entry.sessionId === 'string'
      ? entry.sessionId
      : typeof entry.session_id === 'string'
        ? entry.session_id
        : fallbackId;
    const session = mutableClaudeSession(sessions, id, filepath, project);
    session.startedAt = earlierTimestamp(session.startedAt, timestamp);
    session.endedAt = laterTimestamp(session.endedAt, timestamp);

    if (entry.type === 'user') {
      const message = entry.message as Record<string, unknown> | undefined;
      const content = message?.content;
      const input = safeContent(content);
      const prompt = promptSummary(content);
      // Claude wraps tool results in role=user records and emits slash-command
      // expansions as `isMeta` user records. Neither represents a new user turn.
      if (input && entry.isMeta !== true) {
        session.userTurns++;
        if (prompt && !session.title) Object.assign(session, prompt);
        session.events.push({
          id: `user-${session.events.length + 1}`,
          timestamp,
          type: 'user_message',
          summary: 'User request',
          ...contentFields(input),
        });
      }
      if (Array.isArray(content)) {
        for (const item of content) {
          if (!item || typeof item !== 'object' || (item as Record<string, unknown>).type !== 'tool_result') continue;
          const result = item as Record<string, unknown>;
          const isError = result.is_error;
          const success = typeof isError === 'boolean' ? !isError : undefined;
          if (success !== undefined) session.hasToolResultSemantics = true;
          const toolUseId = typeof result.tool_use_id === 'string' ? result.tool_use_id : undefined;
          const invocation = toolUseId ? toolNames.get(toolUseId) : undefined;
          session.events.push({
            id: `tool-result-${session.events.length + 1}`,
            ...(toolUseId ? { callId: toolUseId } : {}),
            timestamp,
            type: 'tool_result',
            ...(invocation?.isSkill ? { skillName: invocation.name } : invocation ? { toolName: invocation.name } : {}),
            ...(success === undefined ? {} : { success }),
            ...(resultSummary(result.content) ? { resultSummary: resultSummary(result.content) } : {}),
            summary: success === false ? 'Tool result failed' : success ? 'Tool result completed' : 'Tool result received',
            contentAvailable: false,
          });
        }
      }
      continue;
    }

    if (entry.type !== 'assistant') continue;
    const message = entry.message as Record<string, unknown> | undefined;
    if (!message) continue;
    const model = typeof message.model === 'string' ? message.model : 'unknown';
    const usage = (message.usage ?? {}) as Record<string, unknown>;
    const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
    const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;
    const cacheCreationTokens = typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : 0;
    const cacheReadTokens = typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0;
    const totalTokens = inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens;
    const content = message.content;
    const reasoning = thinkingContent(content);
    const assistantText = textContent(content);
    const contentTypes = Array.isArray(content)
      ? new Set(content.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object').map(item => item.type))
      : new Set<unknown>();
    if (totalTokens > 0) {
      const cost = calculateClaudeCost(inputTokens, cacheReadTokens, outputTokens, model, cacheCreationTokens);
      session.models.add(model);
      session.totalTokens += totalTokens;
      session.totalCost += cost;
      session.events.push({
        id: `llm-${session.events.length + 1}`,
        timestamp,
        type: 'llm_call',
        model,
        summary: contentTypes.has('thinking') ? 'Model reasoning' : contentTypes.has('tool_use') ? 'Tool decision' : assistantText ? 'Model response generated' : 'Model inference',
        ...contentFields(reasoning),
        usage: { inputTokens, outputTokens, cacheReadTokens, totalTokens, cost },
      });
    }
    if (assistantText) {
      session.events.push({
        id: `assistant-${session.events.length + 1}`,
        timestamp,
        type: 'assistant_message',
        model: model === 'unknown' ? undefined : model,
        summary: 'Assistant reply',
        ...contentFields(assistantText),
      });
    }

    if (!Array.isArray(content)) continue;
    for (const item of content) {
      if (!item || typeof item !== 'object') continue;
      const tool = item as Record<string, unknown>;
      if (tool.type !== 'tool_use' || typeof tool.name !== 'string') continue;
      const invocation = toolInvocationName(tool.name, tool.input);
      const toolId = typeof tool.id === 'string' ? tool.id : undefined;
      if (toolId) toolNames.set(toolId, invocation);
      if (invocation.isSkill) {
        session.hasSkill = true;
        session.skillCalls++;
      } else {
        session.toolCalls++;
      }
      session.events.push({
        id: `${invocation.isSkill ? 'skill' : 'tool'}-${session.events.length + 1}`,
        ...(toolId ? { callId: toolId } : {}),
        timestamp,
        type: invocation.isSkill ? 'skill_call' : 'tool_call',
        ...(invocation.isSkill ? { skillName: invocation.name } : { toolName: invocation.name }),
        summary: `${invocation.isSkill ? 'Skill' : 'Tool'} ${invocation.name} called`,
        ...(parameterSummary(tool.input) ? { parameterSummary: parameterSummary(tool.input) } : {}),
        contentAvailable: false,
      });
    }
  }
  return [...sessions.values()];
}

function loadClaudeSessions(files: string[]): SessionSource {
  const mutable = files.flatMap(claudeSessionsFromFile);
  const hasSkill = mutable.some(session => session.hasSkill);
  const hasToolResultSemantics = mutable.some(session => session.hasToolResultSemantics);
  const sessions = mutable.map((session): SessionAnalyticsIndexedSession => {
    const startedAt = session.startedAt || new Date(0).toISOString();
    const endedAt = session.endedAt;
    const durationMs = endedAt && Date.parse(endedAt) >= Date.parse(startedAt)
      ? Date.parse(endedAt) - Date.parse(startedAt)
      : undefined;
    const llmCallCount = session.events.filter(event => event.type === 'llm_call').length;
    return {
      summary: {
        id: session.id,
        agent: 'claude',
        ...(session.project ? { project: session.project } : {}),
        ...(session.title ? { title: session.title } : {}),
        ...(sessionDescription(session.userTurns, session.toolCalls, session.skillCalls)
          ? { description: sessionDescription(session.userTurns, session.toolCalls, session.skillCalls) }
          : {}),
        startedAt,
        ...(endedAt ? { endedAt } : {}),
        status: 'unknown',
        models: [...session.models],
        llmCallCount,
        ...(hasSkill ? { skillCallCount: session.skillCalls } : {}),
        toolCallCount: session.toolCalls,
        userTurnCount: session.userTurns,
        ...(durationMs === undefined ? {} : { durationMs }),
        totalTokens: session.totalTokens,
        totalCost: session.totalCost,
      },
      events: session.events.sort((left, right) => left.timestamp.localeCompare(right.timestamp)),
      sourceFile: session.sourceFile,
    };
  });
  return {
    sessions,
    capabilities: {
      userTurns: true,
      skills: hasSkill,
      ...(hasSkill ? { skillSemantics: 'explicit' as const } : {}),
      tools: true,
      // Claude tool_result has an explicit is_error field when success semantics are available.
      toolResults: hasToolResultSemantics,
      contentPreview: false,
    },
    indexedAt: new Date().toISOString(),
  };
}

function loadSource(agent: string, revision: string): SessionSource {
  const cacheKey = `${agent}:${revision}`;
  const cached = sourceCache.get(cacheKey);
  if (cached) return cached;
  // Keep only the current source revision for each agent; revisions change as logs append.
  for (const key of sourceCache.keys()) {
    if (key.startsWith(`${agent}:`)) sourceCache.delete(key);
  }
  let source: SessionSource;
  if (agent === 'codex') {
    const sessions = parseAllSessions().map(codexSessionToIndexed);
    const hasSkill = sessions.some(session => session.events.some(event => event.type === 'skill_call'));
    const hasInferredSkill = sessions.some(session => session.events.some(event => event.type === 'skill_call' && event.skillOrigin === 'inferred'));
    const hasExplicitSkill = sessions.some(session => session.events.some(event => event.type === 'skill_call' && event.skillOrigin !== 'inferred'));
    const hasToolResults = sessions.some(session => session.events.some(event => event.type === 'tool_result'));
    const hasUserTurns = sessions.some(session => session.summary.userTurnCount !== undefined);
    for (const session of sessions) {
      if (hasSkill) session.summary.skillCallCount = session.events.filter(event => event.type === 'skill_call').length;
    }
    source = {
      sessions,
      capabilities: {
        userTurns: hasUserTurns,
        skills: hasSkill,
        ...(hasSkill ? { skillSemantics: hasInferredSkill && hasExplicitSkill ? 'mixed' as const : hasInferredSkill ? 'inferred' as const : 'explicit' as const } : {}),
        tools: true,
        toolResults: hasToolResults,
        contentPreview: false,
      },
      indexedAt: new Date().toISOString(),
    };
  } else if (agent === 'claude') {
    source = loadClaudeSessions(claudeFiles());
  } else {
    source = { sessions: [], capabilities: NO_SESSION_CAPABILITIES, indexedAt: new Date().toISOString() };
  }
  sourceCache.set(cacheKey, source);
  return source;
}

function rangeStart(range: SessionAnalyticsRange): number | undefined {
  if (range === 'all') return undefined;
  const now = new Date();
  if (range === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 60;
  return now.getTime() - days * 24 * 60 * 60 * 1000;
}

function decodeCursor(cursor: string | undefined): string | undefined {
  if (!cursor || cursor.length > 1024) return undefined;
  try {
    return Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    return undefined;
  }
}

function encodeCursor(session: SessionSummary): string {
  return Buffer.from(`${session.startedAt}\u0000${session.id}`).toString('base64url');
}

function filteredSessions(source: SessionSource, filters: SessionAnalyticsFilters): SessionAnalyticsIndexedSession[] {
  const query = filters.query?.trim().toLowerCase();
  const since = rangeStart(filters.range || 'all');
  return source.sessions
    .filter(({ summary }) => !filters.project || summary.project === filters.project)
    .filter(({ summary }) => !filters.model || summary.models.includes(filters.model))
    .filter(({ summary }) => !filters.status || summary.status === filters.status)
    .filter(({ summary }) => !since || Date.parse(summary.startedAt) >= since)
    .filter(({ summary }) => !query
      || summary.id.toLowerCase().includes(query)
      || summary.project?.toLowerCase().includes(query)
      || summary.title?.toLowerCase().includes(query)
      || summary.description?.toLowerCase().includes(query))
    .sort((left, right) => {
      const byStarted = right.summary.startedAt.localeCompare(left.summary.startedAt);
      return byStarted || right.summary.id.localeCompare(left.summary.id);
    });
}

function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function dailyKey(timestamp: string): string {
  return timestamp.slice(0, 10);
}

function durationTurnTrend(sessions: SessionAnalyticsIndexedSession[], capabilities: SessionAnalyticsCapabilities): SessionAnalyticsResponse['durationTurnTrend'] {
  const byDate = new Map<string, SessionAnalyticsIndexedSession[]>();
  for (const session of sessions) {
    const date = dailyKey(session.summary.startedAt);
    byDate.set(date, [...(byDate.get(date) || []), session]);
  }
  return [...byDate.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([date, values]) => {
    const durations = values.map(({ summary }) => summary.durationMs).filter((value): value is number => value !== undefined);
    const userTurns = values.map(({ summary }) => summary.userTurnCount).filter((value): value is number => value !== undefined);
    return {
      date,
      ...(durations.length ? {
        avgDurationMs: durations.reduce((sum, value) => sum + value, 0) / durations.length,
        medianDurationMs: median(durations),
        avgDurationMinutes: durations.reduce((sum, value) => sum + value, 0) / durations.length / 60_000,
      } : {}),
      ...(capabilities.userTurns && userTurns.length ? {
        avgUserTurnCount: userTurns.reduce((sum, value) => sum + value, 0) / userTurns.length,
        avgUserTurns: userTurns.reduce((sum, value) => sum + value, 0) / userTurns.length,
      } : {}),
    };
  });
}

function userTurnDistribution(sessions: SessionAnalyticsIndexedSession[]): SessionAnalyticsResponse['userTurnDistribution'] {
  const buckets = [
    { bucket: '1–2', matches: (value: number) => value >= 1 && value <= 2 },
    { bucket: '3–5', matches: (value: number) => value >= 3 && value <= 5 },
    { bucket: '6–8', matches: (value: number) => value >= 6 && value <= 8 },
    { bucket: '9–12', matches: (value: number) => value >= 9 && value <= 12 },
    { bucket: '13+', matches: (value: number) => value >= 13 },
  ];
  const values = sessions.map(({ summary }) => summary.userTurnCount).filter((value): value is number => value !== undefined);
  return buckets.map(({ bucket, matches }) => {
    const sessionCount = values.filter(matches).length;
    return { bucket, sessionCount, percentage: values.length ? (sessionCount / values.length) * 100 : 0 };
  });
}

export function buildSessionAnalyticsResponse(
  allSessions: SessionAnalyticsIndexedSession[],
  capabilities: SessionAnalyticsCapabilities,
  filters: SessionAnalyticsFilters = {},
): SessionAnalyticsResponse {
  const source: SessionSource = { sessions: allSessions, capabilities, indexedAt: '' };
  const sessions = filteredSessions(source, filters);
  const llmByDate = new Map<string, Record<string, number>>();
  const tools = new Map<string, number>();
  const skills = new Map<string, number>();
  const successfulToolResults: boolean[] = [];
  for (const session of sessions) {
    for (const event of session.events) {
      if (event.type === 'llm_call') {
        const date = dailyKey(event.timestamp);
        const models = llmByDate.get(date) || {};
        const model = event.model || 'unknown';
        models[model] = (models[model] || 0) + 1;
        llmByDate.set(date, models);
      }
      if (event.type === 'tool_call') {
        const name = event.toolName || 'Unknown';
        tools.set(name, (tools.get(name) || 0) + 1);
      }
      if (event.type === 'skill_call') {
        const name = event.skillName || 'Unknown';
        skills.set(name, (skills.get(name) || 0) + 1);
      }
      if (event.type === 'tool_result' && event.success !== undefined) successfulToolResults.push(event.success);
    }
  }
  const durations = sessions.map(({ summary }) => summary.durationMs).filter((value): value is number => value !== undefined);
  const userTurns = sessions.map(({ summary }) => summary.userTurnCount).filter((value): value is number => value !== undefined);
  const llmCallCount = sessions.reduce((sum, { summary }) => sum + summary.llmCallCount, 0);
  const toolCallCount = sessions.reduce((sum, { summary }) => sum + (summary.toolCallCount || 0), 0);
  const skillCallCount = sessions.reduce((sum, { summary }) => sum + (summary.skillCallCount || 0), 0);
  const cursorValue = decodeCursor(filters.cursor);
  const afterCursor = cursorValue
    ? sessions.filter(({ summary }) => `${summary.startedAt}\u0000${summary.id}` < cursorValue)
    : sessions;
  const limit = Math.max(1, Math.min(Math.floor(filters.limit || 20), 100));
  const page = afterCursor.slice(0, limit).map(({ summary }) => summary);
  const nextCursor = afterCursor.length > limit ? encodeCursor(page.at(-1)!) : undefined;
  const toolDistribution: SessionDistributionEntry[] = [...tools.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
  const skillDistribution: SessionDistributionEntry[] = [...skills.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));

  return {
    summary: {
      sessionCount: sessions.length,
      llmCallCount,
      ...(capabilities.skills ? { skillCallCount } : {}),
      // Tool counts have a distinct semantics and remain useful even without Skills.
      ...(sessions.some(({ summary }) => summary.toolCallCount !== undefined) ? { toolCallCount } : {}),
      ...(durations.length ? {
        avgDurationMs: durations.reduce((sum, duration) => sum + duration, 0) / durations.length,
        medianDurationMs: median(durations),
      } : {}),
      ...(capabilities.userTurns && userTurns.length ? { avgUserTurnCount: userTurns.reduce((sum, turns) => sum + turns, 0) / userTurns.length } : {}),
      ...(capabilities.userTurns && userTurns.length ? { longSessionRate: (userTurns.filter(turns => turns >= 13).length / userTurns.length) * 100 } : {}),
      ...(capabilities.toolResults && successfulToolResults.length ? { toolSuccessRate: (successfulToolResults.filter(Boolean).length / successfulToolResults.length) * 100 } : {}),
    },
    llmCallTrend: [...llmByDate.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([date, models]) => ({ date, models, total: Object.values(models).reduce((sum, count) => sum + count, 0) })),
    // An absent field means the source cannot derive that event category at all.
    ...(sessions.some(({ summary }) => summary.toolCallCount !== undefined) ? { toolDistribution } : {}),
    ...(capabilities.skills ? { skillDistribution } : {}),
    durationTurnTrend: durationTurnTrend(sessions, capabilities),
    userTurnDistribution: capabilities.userTurns ? userTurnDistribution(sessions) : [],
    ...(capabilities.userTurns ? { longSessionThreshold: 13 } : {}),
    sessions: page,
    pagination: { ...(nextCursor ? { nextCursor } : {}), totalCount: sessions.length },
    capabilities,
  };
}

export function getSessionAnalytics(agent: string, filters: SessionAnalyticsFilters = {}, revision = getSessionAnalyticsSourceRevision(agent)): SessionAnalyticsResponse {
  const source = loadSource(agent, revision);
  return buildSessionAnalyticsResponse(source.sessions, source.capabilities, filters);
}

export function invalidateSessionAnalyticsSource(agent?: string): void {
  for (const key of sourceCache.keys()) {
    if (!agent || key.startsWith(`${agent}:`)) sourceCache.delete(key);
  }
}

export function buildSessionDetail(
  indexed: SessionAnalyticsIndexedSession,
  capabilities: SessionAnalyticsCapabilities,
  indexedAt: string,
  includeContent = false,
): SessionDetail {
  return {
    session: indexed.summary,
    events: indexed.events.map(event => {
      if (includeContent || !event.content) return event;
      const { content: _content, ...metadata } = event;
      return metadata;
    }),
    indexedAt,
    capabilities: {
      ...capabilities,
      contentPreview: indexed.events.some(event => Boolean(event.contentPreview)),
    },
  };
}

function hydrateClaudeEventContent(indexed: SessionAnalyticsIndexedSession): SessionEvent[] {
  if (!indexed.sourceFile) return indexed.events;
  let raw = '';
  try { raw = readFileSync(indexed.sourceFile, 'utf8'); } catch { return indexed.events; }

  const available = new Map<string, SessionEvent[]>();
  for (const event of indexed.events) {
    if (!event.contentAvailable) continue;
    const key = `${event.type}:${event.timestamp}`;
    const matches = available.get(key) || [];
    matches.push(event);
    available.set(key, matches);
  }
  const hydrated = new Map<string, string>();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try { entry = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (!validTimestamp(entry.timestamp)) continue;
    const message = entry.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (entry.type === 'user' && entry.isMeta === true) continue;
    if (entry.type === 'user') {
      const body = safeContent(content);
      if (!body) continue;
      const event = available.get(`user_message:${entry.timestamp}`)?.shift();
      if (event) hydrated.set(event.id, body);
      continue;
    }
    if (entry.type !== 'assistant') continue;

    // A single Claude assistant record can carry both a private thinking block
    // and its visible text reply. Hydrate each independently by its event type.
    const reasoning = thinkingContent(content);
    if (reasoning) {
      const event = available.get(`llm_call:${entry.timestamp}`)?.shift();
      if (event) hydrated.set(event.id, reasoning);
    }
    const reply = textContent(content);
    if (reply) {
      const event = available.get(`assistant_message:${entry.timestamp}`)?.shift();
      if (event) hydrated.set(event.id, reply);
    }
  }
  return indexed.events.map(event => hydrated.has(event.id) ? { ...event, content: hydrated.get(event.id) } : event);
}

export function getSessionDetail(agent: string, id: string, revision = getSessionAnalyticsSourceRevision(agent), includeContent = false): SessionDetail | undefined {
  const source = loadSource(agent, revision);
  const session = source.sessions.find(candidate => candidate.summary.id === id);
  if (!session) return undefined;
  const hydrated = includeContent && agent === 'claude'
    ? { ...session, events: hydrateClaudeEventContent(session) }
    : session;
  return buildSessionDetail(hydrated, source.capabilities, source.indexedAt, includeContent);
}
