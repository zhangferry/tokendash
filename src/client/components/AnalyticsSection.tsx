import { useMemo } from 'react';
import {
  AreaChart, Area, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import type { AnalyticsResponse, DailyCodeChange, DailyToolCall } from '../../shared/types.js';

const C = ['#4f46e5', '#10b981', '#f59e0b', '#ec4899', '#0ea5e9', '#8b5cf6', '#ef4444', '#14b8a6'];

// --- Shared UI primitives (matching Dashboard style) ---

function Panel({ title, subtitle, children, className = '' }: { title: string; subtitle?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`bg-white rounded-2xl p-5 shadow-[0_1px_3px_rgba(120,113,108,0.06)] ${className}`}>
      <div className="mb-4">
        <h3 className="text-base font-bold text-stone-800">{title}</h3>
        {subtitle && <p className="text-[12px] text-stone-400 mt-0.5">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}

function KPICard({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className={`flex flex-col justify-between rounded-2xl p-5 shadow-[0_1px_3px_rgba(120,113,108,0.06)] transition-shadow duration-200 hover:shadow-[0_4px_12px_rgba(120,113,108,0.09)] ${accent ? 'bg-indigo-50/50' : 'bg-white'}`}>
      <p className="text-[12px] font-medium text-stone-400 mb-2">{label}</p>
      <p className={`text-2xl font-extrabold tracking-tight ${accent ? 'text-indigo-600' : 'text-stone-900'}`}>{value}</p>
      {sub && <p className="text-[11px] text-stone-400 mt-1">{sub}</p>}
    </div>
  );
}

function formatDate(date: string): string {
  const d = new Date(date + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toString();
}

// --- Time range filter helper ---

type TimeRangeKey = 'today' | '7d' | '30d' | '60d' | 'all';

const TIME_RANGES = [
  { key: 'today', days: 1 },
  { key: '7d', days: 7 },
  { key: '30d', days: 30 },
  { key: '60d', days: 60 },
  { key: 'all', days: 0 },
] as const;

function filterByDate<T extends { date: string }>(data: T[], rangeKey: TimeRangeKey): T[] {
  if (rangeKey === 'all') return data;
  if (rangeKey === 'today') {
    const now = new Date();
    const todayStr = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
    return data.filter(d => {
      const dt = new Date(d.date);
      const fieldStr = dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
      return fieldStr === todayStr;
    });
  }
  const range = TIME_RANGES.find(t => t.key === rangeKey);
  const days = range ? range.days : 30;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  return data.filter(d => new Date(d.date) >= cutoff);
}

// --- Props ---

interface AnalyticsSectionProps {
  analytics: AnalyticsResponse;
  timeRange: TimeRangeKey;
}

// --- Component ---

export function AnalyticsSection({ analytics, timeRange }: AnalyticsSectionProps) {
  const { codeChangeTrend, toolCallTrend } = analytics;

  const filteredChanges = useMemo(() => filterByDate(codeChangeTrend, timeRange), [codeChangeTrend, timeRange]);
  const filteredToolTrend = useMemo(() => filterByDate(toolCallTrend, timeRange), [toolCallTrend, timeRange]);

  // Get top 6 tools for the trend chart
  const topTools = useMemo(() => {
    const toolCounts = new Map<string, number>();
    for (const d of toolCallTrend) {
      for (const [key, val] of Object.entries(d)) {
        if (key === 'date') continue;
        toolCounts.set(key, (toolCounts.get(key) || 0) + (val as number));
      }
    }
    return [...toolCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name]) => name);
  }, [toolCallTrend]);

  // Daily averages from filtered data
  const dailyAvg = useMemo(() => {
    if (filteredChanges.length === 0) return { files: 0, added: 0, deleted: 0, net: 0 };
    const days = filteredChanges.length;
    return {
      files: Math.round(filteredChanges.reduce((s, d) => s + d.filesModified, 0) / days),
      added: Math.round(filteredChanges.reduce((s, d) => s + d.linesAdded, 0) / days),
      deleted: Math.round(filteredChanges.reduce((s, d) => s + d.linesDeleted, 0) / days),
      net: Math.round(filteredChanges.reduce((s, d) => s + d.netChange, 0) / days),
    };
  }, [filteredChanges]);

  return (
    <>
      {/* Code Change Trend + Tool Call Trend */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        <Panel title="Code Change Trend" subtitle="Lines added, deleted, and net change">
          {filteredChanges.length > 0 ? (
            <ResponsiveContainer width="100%" height={240}>
              <AreaChart data={filteredChanges}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e7e5e4" vertical={false} />
                <XAxis dataKey="date" tickFormatter={formatDate} tick={{ fill: '#78716c', fontSize: 10 }} interval="preserveStartEnd" />
                <YAxis tickFormatter={(v: number) => formatNumber(v)} tick={{ fill: '#78716c', fontSize: 10 }} width={50} />
                <Tooltip
                  content={({ active, payload, label }) => {
                    if (!active || !payload?.length) return null;
                    return (
                      <div className="bg-white rounded-lg shadow-lg border border-stone-200 px-3 py-2 text-[12px]">
                        <p className="font-semibold text-stone-700 mb-1">{formatDate(label)}</p>
                        {payload.map((p, i) => (
                          <p key={i} style={{ color: p.color }}>
                            {p.name}: {formatNumber(p.value as number)}
                          </p>
                        ))}
                      </div>
                    );
                  }}
                />
                <Area type="monotone" dataKey="linesAdded" name="Added" stroke={C[1]} fill={C[1]} fillOpacity={0.15} strokeWidth={2} />
                <Area type="monotone" dataKey="linesDeleted" name="Deleted" stroke={C[3]} fill={C[3]} fillOpacity={0.08} strokeWidth={2} />
                <Area type="monotone" dataKey="netChange" name="Net" stroke={C[0]} fill={C[0]} fillOpacity={0.05} strokeWidth={2} strokeDasharray="4 2" />
                <Legend iconType="line" wrapperStyle={{ fontSize: 11, paddingTop: 4 }} />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-stone-400 text-[13px] py-8 text-center">No code change data available</p>
          )}
        </Panel>

        <Panel title="Tool Call Trend" subtitle="Daily usage frequency by tool">
          {filteredToolTrend.length > 0 ? (
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={filteredToolTrend}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e7e5e4" vertical={false} />
                <XAxis dataKey="date" tickFormatter={formatDate} tick={{ fill: '#78716c', fontSize: 10 }} interval="preserveStartEnd" />
                <YAxis tick={{ fill: '#78716c', fontSize: 10 }} width={40} />
                <Tooltip
                  content={({ active, payload, label }) => {
                    if (!active || !payload?.length) return null;
                    return (
                      <div className="bg-white rounded-lg shadow-lg border border-stone-200 px-3 py-2 text-[12px]">
                        <p className="font-semibold text-stone-700 mb-1">{formatDate(label)}</p>
                        {payload.map((p, i) => (
                          <p key={i} style={{ color: p.color }}>
                            {p.name}: {p.value}
                          </p>
                        ))}
                      </div>
                    );
                  }}
                />
                {topTools.map((tool, i) => (
                  <Line key={tool} type="monotone" dataKey={tool} stroke={C[i % C.length]} strokeWidth={2} dot={false} />
                ))}
                <Legend iconType="line" wrapperStyle={{ fontSize: 11, paddingTop: 4 }} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-stone-400 text-[13px] py-8 text-center">No tool call trend data available</p>
          )}
        </Panel>
      </div>
    </>
  );
}
