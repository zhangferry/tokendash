import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { fetchSessionDetail } from '../api/client.js';
import { useSessionAnalytics } from '../hooks/useSessionAnalytics.js';
import { formatDate, formatProjectName, formatTokens, formatUSD } from '../utils/formatters.js';
import type { SessionDetail, SessionEvent, SessionSummary } from '../../shared/types.js';

const COLORS = ['#4f46e5', '#0ea5e9', '#f59e0b', '#ec4899', '#10b981', '#8b5cf6'];
const PANEL = 'rounded-2xl bg-white p-5 shadow-[0_1px_3px_rgba(120,113,108,0.06)]';

function formatDuration(duration?: number): string {
  if (duration === undefined || duration === null) return '—';
  const seconds = Math.max(0, Math.round(duration / 1000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours}h ${minutes % 60}m` : minutes ? `${minutes}m` : `${seconds}s`;
}

function shortId(id: string) {
  return id.length > 18 ? `${id.slice(0, 8)}…${id.slice(-7)}` : id;
}

function SessionTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ name: string; value: number; color: string }>; label?: string }) {
  if (!active || !payload?.length) return null;
  return <div className="rounded-xl border border-stone-200/70 bg-white px-3 py-2.5 text-[11px] shadow-[0_8px_30px_rgba(120,113,108,0.12)]">
    {label && <p className="mb-1.5 font-medium text-stone-400">{label}</p>}
    {payload.map(item => <div key={item.name} className="flex min-w-32 justify-between gap-5 py-0.5">
      <span className="flex items-center gap-1.5 text-stone-600"><i className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: item.color }} />{item.name}</span>
      <span className="font-mono text-stone-800">{item.value.toLocaleString()}</span>
    </div>)}
  </div>;
}

function ChartPanel({ anchor, title, subtitle, note, children }: { anchor: string; title: string; subtitle: string; note?: string; children: React.ReactNode }) {
  return <article className={PANEL} data-od-id={anchor}>
    <div className="mb-5 flex items-start justify-between gap-4">
      <div><h3 className="text-[15px] font-semibold tracking-tight text-stone-900">{title}</h3><p className="mt-1 text-[12px] font-medium text-stone-400">{subtitle}</p></div>
      {note && <span className="shrink-0 font-mono text-[10px] text-stone-400">{note}</span>}
    </div>
    {children}
  </article>;
}

function CapabilityValue({ value, available, unavailable }: { value: string; available: boolean; unavailable: string }) {
  return available ? <>{value}</> : <span title={unavailable}>—</span>;
}

function KpiCard({ label, value, detail, accent }: { label: string; value: React.ReactNode; detail: string; accent?: boolean }) {
  return <article className={`${PANEL} flex min-h-36 flex-col`}>
    <span className="text-[12px] font-medium text-stone-400">{label}</span>
    <strong className={`mt-3 font-mono text-3xl font-extrabold tracking-tighter ${accent ? 'text-indigo-600' : 'text-stone-900'}`}>{value}</strong>
    <span className="mt-auto border-t border-stone-100 pt-2.5 text-[11px] font-medium text-stone-400">{detail}</span>
  </article>;
}

type RunStep = {
  id: string;
  timestamp: string;
  type: 'request' | 'model' | 'action' | 'output';
  title: string;
  summary: string;
  primary: SessionEvent;
  related?: SessionEvent;
};

type TaskGroup = {
  id: string;
  index: number;
  request?: SessionEvent;
  events: SessionEvent[];
};

function payloadValue(value?: string) {
  if (!value) return undefined;
  return value.replace(/^(Parameters|Result)\s*/i, '').trim();
}

function formatUsage(usage?: SessionEvent['usage']) {
  if (!usage) return undefined;
  return `${formatTokens(usage.inputTokens)} in · ${formatTokens(usage.outputTokens)} out · ${formatTokens(usage.cacheReadTokens)} cached`;
}

const LOW_SIGNAL_TOOLS = new Set([
  'wait', 'wait_agent', 'list_agents', 'get_goal', 'write_stdin',
  'send_message', 'interrupt_agent', 'followup_task',
]);

function isLowSignalTool(event: SessionEvent) {
  const name = (event.toolName || event.skillName || '').toLowerCase();
  return LOW_SIGNAL_TOOLS.has(name);
}

function isInspectableResult(event?: SessionEvent) {
  if (!event) return false;
  return Boolean(event.contentPreview || event.content || (event.resultSummary && !/body withheld|text result \(0 chars/i.test(event.resultSummary)));
}

function actionSummary(event: SessionEvent, related?: SessionEvent) {
  if (isInspectableResult(related)) return related?.resultSummary || event.summary || 'Invocation recorded';
  if (related?.success === false) return 'Completed with an error';
  if ((event.toolName || event.skillName) === 'spawn_agent') return 'Subtask started';
  return related ? 'Completed' : event.summary || 'Invocation recorded';
}

function taskGroups(events: SessionEvent[]): TaskGroup[] {
  const requests = events.filter(event => event.type === 'user_message' && Boolean(event.contentPreview || event.content));
  if (!requests.length) return [{ id: 'session-activity', index: 0, events: events.filter(event => event.type !== 'input_context') }];
  return requests.map((request, index) => {
    const start = events.indexOf(request);
    const next = index < requests.length - 1 ? events.indexOf(requests[index + 1]!) : events.length;
    return { id: request.id, index, request, events: events.slice(start, next).filter(event => event.type !== 'input_context') };
  });
}

function taskInputContexts(events: SessionEvent[], groups: TaskGroup[]): Array<{ events: SessionEvent[]; changed: boolean }> {
  let snapshot: SessionEvent[] = [];
  return groups.map((group, index) => {
    const requestIndex = group.request ? events.indexOf(group.request) : events.length;
    const previousRequest = index > 0 ? groups[index - 1]?.request : undefined;
    const previousRequestIndex = previousRequest ? events.indexOf(previousRequest) : -1;
    const updates = events.slice(previousRequestIndex + 1, requestIndex).filter(event => event.type === 'input_context');
    if (updates.length) {
      const bySource = new Map(snapshot.map(event => [`${event.inputKind || 'runtime'}\u0000${event.contextLabel || ''}`, event]));
      for (const event of updates) bySource.set(`${event.inputKind || 'runtime'}\u0000${event.contextLabel || ''}`, event);
      snapshot = [...bySource.values()];
    }
    return { events: snapshot, changed: updates.length > 0 };
  });
}

function taskTitle(group: TaskGroup) {
  return group.request?.contentPreview || group.request?.content || 'Session activity without a user request';
}

function taskModelWork(events: SessionEvent[]) {
  const calls = events.filter(event => event.type === 'llm_call');
  const usage = calls.reduce((total, event) => ({
    inputTokens: total.inputTokens + (event.usage?.inputTokens || 0),
    outputTokens: total.outputTokens + (event.usage?.outputTokens || 0),
    cacheReadTokens: total.cacheReadTokens + (event.usage?.cacheReadTokens || 0),
  }), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 });
  return { calls: calls.length, ...usage };
}

function toRunSteps(events: SessionEvent[]): RunStep[] {
  const steps: RunStep[] = [];
  const resultByCallId = new Map(events.filter(event => event.type === 'tool_result' && event.callId).map(event => [event.callId!, event]));
  const pairedResults = new Set<string>();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    const next = events[index + 1];
    if (event.type === 'llm_call') {
      // Token accounting is retained in the task summary. A model card is only
      // useful when the source provides actual, readable reasoning content.
      if (!event.contentPreview && !event.content) continue;
      const hasTextResponse = event.summary === 'Model response generated' && next?.type === 'assistant_message';
      if (hasTextResponse) {
        steps.push({ id: event.id, timestamp: event.timestamp, type: 'output', title: `Model response · ${event.model || 'Unknown model'}`, summary: formatUsage(event.usage) || 'Model response recorded', primary: event, related: next });
        index += 1;
        continue;
      }
      steps.push({ id: event.id, timestamp: event.timestamp, type: 'model', title: `${event.summary || 'Model inference'} · ${event.model || 'Unknown model'}`, summary: formatUsage(event.usage) || 'Model call recorded', primary: event });
      continue;
    }
    if (event.type === 'skill_call' || event.type === 'tool_call') {
      const correlatedResult = event.callId ? resultByCallId.get(event.callId) : undefined;
      const hasResult = Boolean(correlatedResult || next?.type === 'tool_result');
      const related = correlatedResult || (next?.type === 'tool_result' ? next : undefined);
      if (isLowSignalTool(event) && related?.success !== false) {
        if (related) pairedResults.add(related.id);
        continue;
      }
      if (!event.parameterSummary && !isInspectableResult(related) && related?.success !== false) continue;
      if (related) pairedResults.add(related.id);
      const name = event.skillName || event.toolName || 'Unknown invocation';
      steps.push({ id: event.id, timestamp: event.timestamp, type: 'action', title: `${event.type === 'skill_call' ? 'Skill' : 'Tool'} · ${name}`, summary: actionSummary(event, related) || (hasResult ? 'Completed' : 'Invocation recorded'), primary: event, related });
      if (!correlatedResult && hasResult) index += 1;
      continue;
    }
    if (event.type === 'user_message' || event.type === 'input_context') continue;
    if (event.type === 'tool_result') {
      if (pairedResults.has(event.id)) continue;
      if (!isInspectableResult(event) && event.success !== false) continue;
      steps.push({ id: event.id, timestamp: event.timestamp, type: 'action', title: event.success === false ? 'Tool result · failed' : 'Tool result · complete', summary: event.resultSummary || (event.success === false ? 'The tool reported an error' : 'Tool result recorded'), primary: event });
      continue;
    }
    steps.push({ id: event.id, timestamp: event.timestamp, type: 'output', title: event.phase === 'final_answer' ? 'Final response' : 'Agent update', summary: event.summary || (event.phase === 'final_answer' ? 'Final answer delivered' : 'Progress update'), primary: event });
  }
  return steps;
}

function InputContextPanel({ events, open, unchangedFromTask, expandedId, loading, error, withContent, onToggleOpen, onToggle }: {
  events: SessionEvent[];
  open: boolean;
  unchangedFromTask?: number;
  expandedId: string | null;
  loading: boolean;
  error: string | null;
  withContent: boolean;
  onToggleOpen: () => void;
  onToggle: (event: SessionEvent) => void;
}) {
  const counts = events.reduce<Record<string, number>>((all, event) => {
    const key = event.inputKind || 'runtime';
    all[key] = (all[key] || 0) + 1;
    return all;
  }, {});
  return <div className="mt-3 overflow-hidden rounded-xl border border-sky-100 bg-sky-50/35">
    <button type="button" onClick={onToggleOpen} aria-expanded={open} className="flex w-full items-center justify-between gap-4 px-3.5 py-3 text-left hover:bg-sky-50/60">
      <div className="min-w-0"><span className="text-[11px] font-semibold text-stone-700">Context inputs</span><span className="ml-2 text-[10px] text-stone-400">{events.length} item{events.length === 1 ? '' : 's'}</span>{unchangedFromTask !== undefined && <span className="ml-2 rounded-full bg-white/90 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-700">Unchanged from Task {unchangedFromTask + 1}</span>}</div>
      <span className={`shrink-0 text-sm text-stone-400 transition-transform ${open ? 'rotate-180' : ''}`}>⌄</span>
    </button>
    {open && <div className="border-t border-sky-100 px-3.5 py-3"><div className="flex flex-wrap items-start justify-between gap-3"><p className="text-[10px] leading-relaxed text-stone-400">System, developer, and runtime instructions supplied alongside this user message.</p><div className="flex flex-wrap gap-1.5">{(['system', 'developer', 'runtime'] as const).filter(kind => counts[kind]).map(kind => <span key={kind} className="rounded-full border border-sky-100 bg-white/80 px-2 py-1 text-[9px] font-semibold capitalize text-sky-700">{kind} · {counts[kind]}</span>)}</div></div>
    <div className="mt-3 grid gap-2">{events.map(event => {
      const expanded = expandedId === event.id;
      return <article key={event.id} className="min-w-0 rounded-lg border border-sky-100/80 bg-white/80 px-3 py-2.5">
        <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="text-[10px] font-bold uppercase tracking-wide text-sky-600">{event.contextLabel || 'Input context'}</p><p className="mt-1 line-clamp-2 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-stone-600">{event.contentPreview || event.summary}</p></div><div className="flex shrink-0 gap-1"><span className="rounded-full bg-sky-50 px-1.5 py-0.5 text-[9px] font-semibold capitalize text-sky-600">{event.inputKind || 'runtime'}</span>{event.contentTruncated && <span className="rounded-full bg-amber-50 px-1.5 py-0.5 text-[9px] font-semibold text-amber-700" title="Source exceeded the 64,000 character detail limit">truncated</span>}</div></div>
        {event.contentAvailable && <><button onClick={() => onToggle(event)} aria-expanded={expanded} className="mt-2 text-[10px] font-semibold text-indigo-600 hover:text-indigo-700">{expanded ? loading ? 'Loading full context…' : 'Hide full context' : withContent ? 'Show full context' : 'Read full context'}</button>{expanded && <div className="mt-2 max-h-72 overflow-auto rounded-lg bg-stone-950 px-3 py-2.5">{loading && <p className="text-[10px] text-stone-400">Loading full context…</p>}{error && <p className="text-[10px] text-rose-300">{error}</p>}{withContent && event.content && <pre className="whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-stone-200">{event.content}</pre>}</div>}</>}
      </article>;
    })}</div></div>}
  </div>;
}

function SelectedTaskOverview({ group, modelWork }: { group: TaskGroup; modelWork: ReturnType<typeof taskModelWork> }) {
  return <section data-od-id="selected-task-overview" aria-label={`Task ${group.index + 1} overview`} className="mt-4 rounded-xl border border-stone-100 bg-stone-50/60 p-4">
    <div className="flex items-center justify-between gap-3"><div><h3 className="text-[13px] font-semibold text-stone-900">Task overview</h3><p className="mt-0.5 text-[11px] text-stone-400">Model work for Task {group.index + 1}</p></div>{group.request && <time className="font-mono text-[10px] text-stone-400">{new Date(group.request.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>}</div>
    <div className="mt-3 grid grid-cols-2 divide-x divide-stone-200 sm:grid-cols-4"><div className="px-2 first:pl-0"><p className="text-[9px] font-semibold uppercase tracking-wide text-stone-400">Model calls</p><p className="mt-1 font-mono text-[11px] font-bold text-stone-700">{modelWork.calls}</p></div><div className="px-2"><p className="text-[9px] font-semibold uppercase tracking-wide text-stone-400">Input</p><p className="mt-1 font-mono text-[11px] font-bold text-stone-700">{formatTokens(modelWork.inputTokens)}</p></div><div className="px-2"><p className="text-[9px] font-semibold uppercase tracking-wide text-stone-400">Output</p><p className="mt-1 font-mono text-[11px] font-bold text-stone-700">{formatTokens(modelWork.outputTokens)}</p></div><div className="px-2"><p className="text-[9px] font-semibold uppercase tracking-wide text-stone-400">Cached</p><p className="mt-1 font-mono text-[11px] font-bold text-stone-700">{formatTokens(modelWork.cacheReadTokens)}</p></div></div>
  </section>;
}

function TaskInputPanel({ group, contextEvents, contextOpen, unchangedFromTask, expandedId, loading, error, withContent, onToggleContextOpen, onToggleContext, onToggleRequest }: {
  group: TaskGroup;
  contextEvents: SessionEvent[];
  contextOpen: boolean;
  unchangedFromTask?: number;
  expandedId: string | null;
  loading: boolean;
  error: string | null;
  withContent: boolean;
  onToggleContextOpen: () => void;
  onToggleContext: (event: SessionEvent) => void;
  onToggleRequest: () => void;
}) {
  const requestExpanded = expandedId === `request-${group.id}`;
  return <section data-od-id="task-input" aria-label={`Input for Task ${group.index + 1}`} className="mt-4 rounded-xl border border-violet-100 bg-violet-50/30 p-4">
    <div><h3 className="text-[13px] font-semibold text-stone-900">Input · Task {group.index + 1}</h3><p className="mt-0.5 text-[11px] text-stone-400">The user message and context that shaped this task.</p></div>
    <article className="mt-3 rounded-xl border border-violet-100 bg-white/80 px-3.5 py-3"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="text-[10px] font-bold uppercase tracking-[0.14em] text-violet-500">User message</p><p className="mt-1 whitespace-pre-wrap text-[12px] leading-relaxed text-stone-700">{group.request?.contentPreview || taskTitle(group)}</p></div>{group.request && <time className="shrink-0 font-mono text-[10px] text-stone-400">{new Date(group.request.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>}</div>{group.request?.contentAvailable && <><button onClick={onToggleRequest} aria-expanded={requestExpanded} className="mt-2 text-[10px] font-semibold text-indigo-600 hover:text-indigo-700">{requestExpanded ? loading ? 'Loading full message…' : 'Hide full message' : withContent ? 'Show full message' : 'Read full message'}</button>{requestExpanded && <>{loading && <p className="mt-2 text-[10px] text-stone-400">Loading full message…</p>}{error && <p className="mt-2 text-[10px] text-rose-600">{error}</p>}{withContent && group.request.content && <p className="mt-2 whitespace-pre-wrap rounded-lg bg-violet-50/50 p-3 text-[11px] leading-relaxed text-stone-600">{group.request.content}</p>}</>}</>}</article>
    <InputContextPanel events={contextEvents} open={contextOpen} unchangedFromTask={unchangedFromTask} expandedId={expandedId} loading={loading} error={error} withContent={withContent} onToggleOpen={onToggleContextOpen} onToggle={onToggleContext} />
  </section>;
}

function DetailDialog({ agent, session, onClose, restoreFocus }: { agent: string; session: SessionSummary; onClose: () => void; restoreFocus: () => void }) {
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  const [contentError, setContentError] = useState<string | null>(null);
  const [withContent, setWithContent] = useState(false);
  const [expandedStep, setExpandedStep] = useState<string | null>(null);
  const [selectedTask, setSelectedTask] = useState<string | null>(null);
  const [contextOpen, setContextOpen] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  const load = async (content: boolean) => {
    const keepDialogStable = content && detail !== null;
    if (keepDialogStable) { setContentLoading(true); setContentError(null); }
    else { setLoading(true); setError(null); }
    try { setDetail(await fetchSessionDetail(agent, session.id, content)); }
    catch (err) {
      const message = err instanceof Error ? err.message : 'Content unavailable';
      if (keepDialogStable) setContentError(message); else setError(message);
    } finally {
      if (keepDialogStable) setContentLoading(false); else setLoading(false);
    }
  };
  useEffect(() => { void load(false); }, [agent, session.id]);
  useEffect(() => {
    dialogRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { onClose(); restoreFocus(); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, restoreFocus]);
  const events = detail?.events || [];
  const meta = detail?.session || session;
  const inferredSkills = detail?.capabilities.skillSemantics === 'inferred';
  const mixedSkills = detail?.capabilities.skillSemantics === 'mixed';
  const groups = useMemo(() => taskGroups(events), [events]);
  const activeGroup = groups.find(group => group.id === selectedTask) || groups[0];
  const activeGroupIndex = activeGroup ? groups.indexOf(activeGroup) : -1;
  const inputContexts = useMemo(() => taskInputContexts(events, groups), [events, groups]);
  const activeInputContext = activeGroupIndex >= 0 ? inputContexts[activeGroupIndex] : undefined;
  const inputContext = activeInputContext?.events || [];
  const unchangedFromTask = activeGroupIndex > 0 && !activeInputContext?.changed ? groups[activeGroupIndex - 1]!.index : undefined;
  const steps = useMemo(() => activeGroup ? toRunSteps(activeGroup.events) : [], [activeGroup]);
  const modelWork = useMemo(() => activeGroup ? taskModelWork(activeGroup.events) : { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }, [activeGroup]);
  const revealContent = () => { setWithContent(true); void load(true); };
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/35 p-4 backdrop-blur-[2px]" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) { onClose(); restoreFocus(); } }}>
    <section ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="session-title" className="flex max-h-[min(780px,calc(100vh-32px))] w-[min(920px,calc(100vw-32px))] flex-col overflow-hidden rounded-2xl bg-white shadow-2xl outline-none" data-od-id="session-detail-dialog">
      <header className="flex items-start justify-between border-b border-stone-100 px-6 py-5">
        <div className="min-w-0"><p className="text-[10px] font-bold uppercase tracking-[0.16em] text-stone-400">Task run</p><h2 id="session-title" className="mt-1 truncate text-lg font-bold tracking-tight text-stone-900" title={meta.title}>{meta.title || 'Session activity'}</h2><div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-stone-400"><span className="font-mono" title={session.id}>{shortId(session.id)}</span>{meta.project && <span>{formatProjectName(meta.project)}</span>}<span className={`rounded-full px-1.5 py-0.5 font-semibold ${meta.status === 'complete' ? 'bg-emerald-50 text-emerald-700' : meta.status === 'active' ? 'bg-indigo-50 text-indigo-600' : 'bg-stone-100 text-stone-500'}`}>{meta.status === 'complete' ? 'Completed' : meta.status === 'active' ? 'Running' : 'Recorded'}</span></div></div>
        <button onClick={() => { onClose(); restoreFocus(); }} aria-label="Close dialog" className="flex h-7 w-7 items-center justify-center rounded-lg text-xl leading-none text-stone-400 hover:bg-stone-100 hover:text-stone-700">×</button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <section aria-label="Session overview" className="rounded-xl border border-stone-100 bg-stone-50/60 p-4">
          <div className="flex items-center justify-between gap-3"><div><p className="text-[10px] font-bold uppercase tracking-[0.14em] text-stone-400">Session overview</p><p className="mt-1 text-[12px] leading-relaxed text-stone-600">{meta.description || 'Local session metadata, organized as one agent run.'}</p></div><span className="shrink-0 font-mono text-[10px] text-stone-400">{new Date(meta.startedAt).toLocaleString()}</span></div>
          <div className="mt-4 grid grid-cols-2 divide-x divide-stone-200 sm:grid-cols-4">
            {[["LLM calls", meta.llmCallCount], [meta.skillCallCount !== undefined ? inferredSkills ? "Skill uses · inferred" : mixedSkills ? "Skill uses · mixed" : "Skill calls" : "Tool calls", meta.skillCallCount ?? meta.toolCallCount ?? '—'], ["Total tokens", formatTokens(meta.totalTokens)], ["Duration", formatDuration(meta.durationMs)]].map(([label, value]) => <div key={String(label)} className="px-3 first:pl-0"><p className="text-[10px] font-semibold uppercase tracking-wide text-stone-400">{label}</p><p className="mt-1 font-mono text-sm font-bold text-stone-800">{value}</p></div>)}
          </div>
        </section>
        <div className="mt-6"><h3 className="text-[13px] font-semibold text-stone-900">Tasks in this session</h3><p className="mt-0.5 text-[11px] text-stone-400">Requests, meaningful work, and delivered answers. Routine runtime noise is omitted.</p></div>
        {loading ? <div className="mt-4 space-y-3">{[1, 2, 3].map(i => <div key={i} className="skeleton h-16 rounded-xl" />)}</div> : error ? <div className="mt-4 rounded-xl bg-rose-50 p-4 text-sm text-rose-700">{error} <button onClick={() => void load(withContent)} className="ml-2 font-semibold underline">Retry</button></div> : !activeGroup ? <div className="mt-4 rounded-xl bg-stone-50 p-4 text-sm text-stone-500">No readable task activity is available for this session.</div> : <><nav aria-label="Tasks in this session" className="mt-4 grid gap-2 sm:grid-cols-2">{groups.map(group => <button key={group.id} onClick={() => { setSelectedTask(group.id); setExpandedStep(null); setContextOpen(false); }} className={`min-w-0 rounded-xl border px-3 py-2.5 text-left transition-colors ${activeGroup.id === group.id ? 'border-indigo-200 bg-indigo-50/70' : 'border-stone-100 bg-white hover:border-stone-200'}`}><span className="block text-[10px] font-bold uppercase tracking-wide text-stone-400">Task {group.index + 1}</span><span className="mt-0.5 block truncate text-[11px] font-semibold text-stone-700">{taskTitle(group)}</span></button>)}</nav>
        <SelectedTaskOverview group={activeGroup} modelWork={modelWork} />
        <TaskInputPanel group={activeGroup} contextEvents={inputContext} contextOpen={contextOpen} unchangedFromTask={unchangedFromTask} expandedId={expandedStep} loading={contentLoading} error={contentError} withContent={withContent} onToggleContextOpen={() => { setContextOpen(open => !open); setExpandedStep(null); }} onToggleContext={event => { const opening = expandedStep !== event.id; setExpandedStep(opening ? event.id : null); if (opening && !withContent) revealContent(); }} onToggleRequest={() => { const requestId = `request-${activeGroup.id}`; const opening = expandedStep !== requestId; setExpandedStep(opening ? requestId : null); if (opening && !withContent) revealContent(); }} />
        <section data-od-id="task-activity" aria-label={`Task ${activeGroup.index + 1} activity`} className="mt-5"><div><h3 className="text-[13px] font-semibold text-stone-900">Task activity</h3><p className="mt-0.5 text-[11px] text-stone-400">Agent updates, inspectable actions, and the delivered response</p></div>
        {steps.length === 0 ? <div className="mt-4 rounded-xl bg-stone-50 p-4 text-sm text-stone-500">This task has token accounting but no readable progress, action, or response content.</div> : <ol className="mt-4 space-y-2.5">{steps.map((step, index) => {
          const detailEvents = [step.primary, step.related].filter((value): value is SessionEvent => Boolean(value));
          const contentEvent = detailEvents.find(item => item.contentPreview || item.contentAvailable);
          const hasPayload = detailEvents.some(item => item.parameterSummary || item.resultSummary || item.contentAvailable || (withContent && item.content));
          const contentLabel = contentEvent?.type === 'user_message' ? 'input' : contentEvent?.type === 'llm_call' ? 'reasoning' : 'response';
          const color = step.type === 'action' ? (detailEvents.some(item => item.success === false) ? 'bg-rose-500' : 'bg-emerald-500') : step.type === 'model' ? 'bg-indigo-500' : step.type === 'request' ? 'bg-violet-500' : 'bg-sky-500';
          const toggleDetails = () => {
            const opening = expandedStep !== step.id;
            setExpandedStep(opening ? step.id : null);
            if (opening && contentEvent?.contentAvailable && !withContent) revealContent();
          };
          const inferredSkill = step.primary.type === 'skill_call' && step.primary.skillOrigin === 'inferred';
          return <li key={step.id} className="relative grid grid-cols-[62px_18px_minmax(0,1fr)] gap-3"><time className="pt-3 font-mono text-[10px] text-stone-400">{new Date(step.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time><div className="relative flex justify-center"><i className={`z-10 mt-3 h-2.5 w-2.5 rounded-full ring-4 ring-white ${color}`} />{index < steps.length - 1 && <span className="absolute top-6 bottom-[-12px] w-px bg-stone-200" />}</div><article className="min-w-0 rounded-xl border border-stone-100 bg-white px-3.5 py-3 shadow-[0_1px_2px_rgba(120,113,108,0.04)]"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="text-[12px] font-semibold text-stone-700">{step.title}</p><p className="mt-0.5 text-[11px] leading-relaxed text-stone-400">{step.summary}</p>{contentEvent?.contentPreview && <p className="mt-2 whitespace-pre-wrap border-l-2 border-stone-200 pl-2.5 text-[11px] leading-relaxed text-stone-600">{contentEvent.contentPreview}</p>}</div>{step.type === 'action' && <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide ${inferredSkill ? 'bg-amber-50 text-amber-700' : detailEvents.some(item => item.success === false) ? 'bg-rose-50 text-rose-600' : 'bg-emerald-50 text-emerald-700'}`}>{inferredSkill ? 'inferred' : detailEvents.some(item => item.success === false) ? 'failed' : 'done'}</span>}</div>{hasPayload && <><button onClick={toggleDetails} aria-expanded={expandedStep === step.id} className="mt-2 text-[10px] font-semibold text-indigo-600 hover:text-indigo-700">{expandedStep === step.id ? contentLoading ? `Loading full ${contentLabel}…` : 'Hide details' : contentEvent?.contentAvailable && !withContent ? `Read full ${contentLabel}` : 'Show details'}</button>{expandedStep === step.id && <dl className="mt-2 grid gap-2 rounded-lg bg-stone-50 px-3 py-2.5 text-[10px] leading-relaxed">{contentLoading && <p className="text-stone-400">Loading full {contentLabel}…</p>}{contentError && <p className="text-rose-600">{contentError}</p>}{detailEvents.flatMap(item => [{ label: 'Parameters', value: payloadValue(item.parameterSummary) }, { label: 'Result', value: payloadValue(item.resultSummary) }, ...(withContent && item.content ? [{ label: item.type === 'user_message' ? 'Full input' : item.type === 'llm_call' ? 'Full reasoning' : 'Full response', value: item.content }] : [])]).filter(item => item.value).map((item, payloadIndex) => <div key={`${item.label}-${payloadIndex}`} className="grid grid-cols-[72px_minmax(0,1fr)] gap-2"><dt className="font-semibold uppercase tracking-wide text-stone-400">{item.label}</dt><dd className="break-words whitespace-pre-wrap font-mono text-stone-600">{item.value}</dd></div>)}</dl>}</>}</article></li>;
        })}</ol>}</section></>}
      </div>
      <footer className="flex items-center justify-between border-t border-stone-100 px-6 py-3 text-[10px] text-stone-400"><span>Local index · {detail?.indexedAt ? new Date(detail.indexedAt).toLocaleString() : 'metadata only'}</span><button onClick={() => void navigator.clipboard?.writeText(session.id)} className="rounded-lg border border-stone-200 px-2.5 py-1 font-semibold text-stone-600 hover:bg-stone-50">Copy session ID</button></footer>
    </section>
  </div>;
}

export function SessionAnalyticsSection({ agent, project, range, refreshVersion }: { agent: string; project: string; range: string; refreshVersion: number }) {
  const state = useSessionAnalytics({ agent, project, range }, refreshVersion);
  const [selected, setSelected] = useState<SessionSummary | null>(null);
  const openerRef = useRef<HTMLTableRowElement | null>(null);
  const data = state.data;
  const capabilities = data?.capabilities;
  const llmTrendData = useMemo(() => (data?.llmCallTrend || []).map(entry => ({ date: entry.date, ...entry.models })), [data?.llmCallTrend]);
  const models = useMemo(() => (data?.llmCallTrend || []).reduce<string[]>((all, day) => {
    Object.keys(day.models).forEach(key => { if (!all.includes(key)) all.push(key); }); return all;
  }, []).slice(0, 6), [data?.llmCallTrend]);
  const durationTrendData = useMemo(() => (data?.durationTurnTrend || []).map(entry => ({
    date: entry.date,
    avgDurationMinutes: entry.avgDurationMs === undefined ? undefined : entry.avgDurationMs / 60_000,
    avgUserTurns: entry.avgUserTurnCount,
  })), [data?.durationTurnTrend]);
  const hasSkills = Boolean(capabilities?.skills);
  const inferredSkills = capabilities?.skillSemantics === 'inferred';
  const mixedSkills = capabilities?.skillSemantics === 'mixed';
  const derivedSkills = inferredSkills || mixedSkills;
  const hasToolCalls = data?.summary.toolCallCount !== undefined;
  const distribution = useMemo(() => {
    const values = data?.toolDistribution || [];
    if (values.length <= 6) return values;
    const visible = values.slice(0, 5);
    return [...visible, { name: 'Other tools', count: values.slice(5).reduce((sum, entry) => sum + entry.count, 0) }];
  }, [data?.toolDistribution]);
  const open = (session: SessionSummary, target: HTMLTableRowElement) => { openerRef.current = target; setSelected(session); };
  const close = () => setSelected(null);
  const restoreFocus = () => openerRef.current?.focus();

  if (!data && state.loading) return <section className="space-y-4" aria-label="Loading session analytics"><div className="skeleton h-7 w-56 rounded-lg" /><div className="grid grid-cols-2 gap-4 lg:grid-cols-5">{[1, 2, 3, 4, 5].map(i => <div key={i} className="skeleton h-36 rounded-2xl" />)}</div><div className="grid gap-4 lg:grid-cols-2">{[1, 2, 3, 4].map(i => <div key={i} className="skeleton h-[330px] rounded-2xl" />)}</div></section>;
  if (state.error && !data) return <section className="rounded-2xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-700"><p>{state.error}</p><button onClick={state.retry} className="mt-2 font-semibold underline">Retry sessions</button></section>;
  if (!data) return null;

  const summary = data.summary;
  const available = (key: keyof NonNullable<typeof capabilities>) => Boolean(capabilities?.[key]);
  return <section className="space-y-4" aria-label="Session analytics">
    <div className="flex items-center justify-between gap-4"><div><h2 className="text-xl font-bold tracking-tight text-stone-900">Session analytics</h2><p className="mt-1 text-[12px] font-medium text-stone-400">{summary.sessionCount.toLocaleString()} sessions indexed{state.loading ? ' · Updating' : ''}</p></div><span className="rounded-full bg-stone-100 px-2.5 py-1 text-[10px] font-semibold text-stone-500">Local metadata only</span></div>
    <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-5" data-od-id="session-kpi-row">
      <KpiCard label="Total sessions" value={summary.sessionCount.toLocaleString()} detail="In the selected period" accent />
      <KpiCard label="LLM calls" value={summary.llmCallCount.toLocaleString()} detail={`${summary.sessionCount ? (summary.llmCallCount / summary.sessionCount).toFixed(1) : '0'} calls per session`} />
      <KpiCard label="Tool calls" value={<CapabilityValue value={(summary.toolCallCount ?? 0).toLocaleString()} available={hasToolCalls} unavailable="Not available for this agent" />} detail={hasToolCalls ? 'Recognized tool events' : 'Not available for this agent'} />
      <KpiCard label="Avg. session duration" value={formatDuration(summary.avgDurationMs)} detail={summary.medianDurationMs !== undefined ? `Median ${formatDuration(summary.medianDurationMs)}` : 'Completed sessions only'} />
      <KpiCard label={derivedSkills ? 'Skill uses' : 'Skill calls'} value={<CapabilityValue value={(summary.skillCallCount ?? 0).toLocaleString()} available={hasSkills} unavailable="Not available for this agent" />} detail={hasSkills ? inferredSkills ? 'Inferred from SKILL.md reads' : mixedSkills ? 'Explicit and inferred usage' : 'Explicit Skill invocations' : 'Not available for this agent'} />
    </div>
    <div className="grid gap-4 lg:grid-cols-2" data-od-id="session-charts-primary">
      <ChartPanel anchor="llm-call-trend" title="LLM call trend" subtitle="Daily model calls across completed and active sessions" note="calls / day">
        <ResponsiveContainer width="100%" height={250}><BarChart data={llmTrendData}><CartesianGrid stroke="#e8e6e1" vertical={false} /><XAxis dataKey="date" axisLine={false} tickLine={false} /><YAxis allowDecimals={false} axisLine={false} tickLine={false} /><Tooltip content={<SessionTooltip />} /><Legend wrapperStyle={{ fontSize: 11, paddingTop: 12 }} />{models.map((model, index) => <Bar key={model} dataKey={model} stackId="calls" fill={COLORS[index]} fillOpacity={0.85} radius={index === models.length - 1 ? [4, 4, 0, 0] : undefined} />)}</BarChart></ResponsiveContainer>
      </ChartPanel>
      <ChartPanel anchor="tool-call-distribution" title="Tool call distribution" subtitle="Bash, MCP, TaskUpdate, and other local tools" note={`${summary.toolCallCount ?? 0} total`}>
        {hasToolCalls ? <div className="min-w-0 space-y-4 pt-1">{distribution.map((entry, index) => { const max = Math.max(...distribution.map(item => item.count), 1); return <div key={entry.name} className="group grid min-w-0 grid-cols-[minmax(96px,120px)_minmax(0,1fr)_36px] items-center gap-3 text-[11px]" title={`${entry.name}: ${entry.count}`}><span className="truncate font-medium text-stone-600">{entry.name}</span><div className="min-w-0 overflow-hidden"><div className="h-2 w-full rounded-full bg-stone-100"><div className="h-full max-w-full rounded-full transition-all" style={{ width: `${Math.min(100, (entry.count / max) * 100)}%`, backgroundColor: COLORS[index % COLORS.length] }} /></div></div><span className="text-right font-mono text-stone-700">{entry.count}</span></div>; })}</div> : <div className="flex h-[250px] items-center justify-center rounded-xl bg-stone-50 px-8 text-center text-sm text-stone-400">Tool calls are not available from this agent’s local logs.</div>}
      </ChartPanel>
    </div>
    <div className="grid gap-4 lg:grid-cols-2" data-od-id="session-charts-secondary">
      <ChartPanel anchor="session-duration-trend" title="Session duration & turns" subtitle="Average session length and conversation volume by day" note="selected range">
        <ResponsiveContainer width="100%" height={250}><LineChart data={durationTrendData}><CartesianGrid stroke="#e8e6e1" vertical={false} /><XAxis dataKey="date" axisLine={false} tickLine={false} /><YAxis yAxisId="duration" tickFormatter={(v: number) => `${v}m`} axisLine={false} tickLine={false} /><YAxis yAxisId="turns" orientation="right" hide={!available('userTurns')} axisLine={false} tickLine={false} /><Tooltip /><Legend wrapperStyle={{ fontSize: 11, paddingTop: 12 }} /><Line yAxisId="duration" type="monotone" dataKey="avgDurationMinutes" name="Avg. duration" stroke="#4f46e5" strokeWidth={2.5} dot={false} />{available('userTurns') && <Line yAxisId="turns" type="monotone" dataKey="avgUserTurns" name="Avg. turns / session" stroke="#10b981" strokeWidth={2} strokeDasharray="4 3" dot={false} />}</LineChart></ResponsiveContainer>
      </ChartPanel>
      <ChartPanel anchor="skill-usage" title="Skill usage" subtitle={inferredSkills ? 'Conservatively inferred from process-level SKILL.md reads' : mixedSkills ? 'Explicit calls combined with conservative process inference' : 'Explicit Skill invocations in the selected period'} note={hasSkills ? `${summary.skillCallCount ?? 0} total${inferredSkills ? ' · inferred' : mixedSkills ? ' · mixed' : ''}` : 'unavailable'}>
        {hasSkills ? <><div className="mb-4 flex items-center rounded-xl border border-emerald-100 bg-emerald-50/60 px-4 py-3"><div><p className="text-[10px] font-semibold uppercase tracking-wide text-emerald-700/70">{derivedSkills ? 'Total skill uses' : 'Total skill calls'}</p><p className="mt-0.5 font-mono text-base font-bold text-emerald-700">{(summary.skillCallCount ?? 0).toLocaleString()}</p></div><span className="mx-5 h-8 w-px bg-emerald-200" /><div><p className="text-[10px] font-semibold uppercase tracking-wide text-emerald-700/70">Distinct skills</p><p className="mt-0.5 font-mono text-base font-bold text-emerald-700">{(data.skillDistribution || []).length}</p></div></div><ResponsiveContainer width="100%" height={180}><BarChart data={data.skillDistribution || []}><CartesianGrid stroke="#e8e6e1" vertical={false} /><XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fontSize: 10 }} /><YAxis allowDecimals={false} axisLine={false} tickLine={false} /><Tooltip content={<SessionTooltip />} /><Bar dataKey="count" name={derivedSkills ? 'Uses' : 'Calls'} fill="#4f46e5" fillOpacity={0.82} radius={[5, 5, 0, 0]}>{(data.skillDistribution || []).map((_, index) => <Cell key={index} fill={COLORS[index % COLORS.length]} />)}</Bar></BarChart></ResponsiveContainer></> : <div className="flex h-[250px] items-center justify-center rounded-xl bg-stone-50 px-8 text-center text-sm text-stone-400">Skill calls are not available from this agent’s local logs.</div>}
      </ChartPanel>
    </div>
    <article className={PANEL} data-od-id="session-detail-table"><div className="mb-4 flex flex-col justify-between gap-3 sm:flex-row sm:items-start"><div><h3 className="text-[15px] font-semibold tracking-tight text-stone-900">Session detail</h3><p className="mt-1 text-[12px] font-medium text-stone-400">Open a session to inspect its model, skill, tool, and output event sequence.</p></div><input value={state.query} onChange={event => state.setQuery(event.target.value)} aria-label="Search sessions" placeholder="Search session ID or project" className="h-8 w-full rounded-lg border border-stone-200 px-3 text-[12px] outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 sm:w-[205px]" /></div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1040px] text-[11px]">
          <thead><tr className="border-b border-stone-200 text-left text-[10px] font-semibold uppercase tracking-wide text-stone-400"><th className="px-3 py-3">Session</th><th className="w-52 px-3 py-3">Context</th><th className="px-3 py-3">Project</th><th className="px-3 py-3">Started</th><th className="px-3 py-3">Model</th><th className="px-3 py-3 text-right">LLM calls</th><th className="px-3 py-3 text-right">Tools</th><th className="px-3 py-3 text-right">User turns</th><th className="px-3 py-3 text-right">Duration</th><th /></tr></thead>
          <tbody>{data.sessions.map((session, index) => <tr key={`${session.id}-${session.startedAt}-${index}`} tabIndex={0} onClick={event => open(session, event.currentTarget)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(session, event.currentTarget); } }} className="cursor-pointer border-b border-stone-100 outline-none transition-colors hover:bg-stone-50 focus:bg-stone-50">
            <td className="px-3 py-3 font-mono font-semibold text-stone-700" title={session.id}>{shortId(session.id)}</td>
            <td className="max-w-52 px-3 py-3"><p className="truncate font-medium text-stone-700" title={session.title}>{session.title || 'Session activity'}</p>{session.description && <p className="mt-0.5 truncate text-[10px] text-stone-400" title={session.description}>{session.description}</p>}</td>
            <td className="max-w-36 truncate px-3 py-3 font-medium text-stone-600">{session.project ? formatProjectName(session.project) : '—'}</td><td className="px-3 py-3 font-mono text-stone-500">{formatDate(session.startedAt)}</td><td className="max-w-32 truncate px-3 py-3 text-stone-600"><i className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-indigo-500" />{session.models[0] || 'Unknown'}</td><td className="px-3 py-3 text-right font-mono text-stone-700">{session.llmCallCount}</td><td className="px-3 py-3 text-right font-mono text-stone-700">{session.toolCallCount ?? '—'}</td><td className="px-3 py-3 text-right font-mono text-stone-700">{session.userTurnCount ?? '—'}</td><td className="px-3 py-3 text-right font-mono text-stone-700">{formatDuration(session.durationMs)}</td><td className="px-3 py-3 text-lg leading-none text-stone-400">›</td>
          </tr>)}</tbody>
        </table>
      </div>
      {data.sessions.length === 0 && <div className="py-10 text-center text-sm text-stone-400">No sessions found for this filter.</div>}
      <div className="mt-4 flex items-center justify-between border-t border-stone-100 pt-3"><span className="text-[11px] text-stone-400">{data.pagination.totalCount === undefined ? 'Cursor pagination' : `${data.pagination.totalCount} sessions`}</span><div className="flex gap-2"><button onClick={state.previousPage} disabled={!state.hasPreviousPage} className="rounded-lg border border-stone-200 px-2.5 py-1 text-[11px] font-semibold text-stone-600 disabled:opacity-40">Previous</button><button onClick={state.nextPage} disabled={!data.pagination.nextCursor} className="rounded-lg border border-stone-200 px-2.5 py-1 text-[11px] font-semibold text-stone-600 disabled:opacity-40">Next</button></div></div>
    </article>
    <p className="px-1 text-[11px] leading-relaxed text-stone-400">This tab is populated only from locally extractable session metadata and event records. Session content is loaded after an explicit user action.</p>
    {selected && <DetailDialog agent={agent} session={selected} onClose={close} restoreFocus={restoreFocus} />}
  </section>;
}
