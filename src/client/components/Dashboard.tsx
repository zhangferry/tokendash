import { useState, useMemo, useCallback, useEffect } from 'react';
import {
  BarChart, Bar, Cell, LineChart, Line,
  ComposedChart, AreaChart, Area, PieChart, Pie,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { fetchDaily, fetchProjects, fetchBlocks, fetchAgents, fetchAnalytics } from '../api/client.js';
import type { AgentsResponse } from '../api/client.js';
import { useCcusageData } from '../hooks/useCcusageData.js';
import { useLocalStorageState } from '../hooks/useLocalStorageState.js';
import { formatDate, formatTokens, formatUSD, formatPercent, formatProjectName } from '../utils/formatters.js';
import { costSavedByCache } from '../utils/cacheCalculations.js';

import { shortModelName } from '../utils/modelNames.js';
import { AnalyticsSection } from './AnalyticsSection.js';
import type { DailyEntry, MetricMode } from '../../shared/types.js';

const C = ['#4f46e5', '#10b981', '#f59e0b', '#ec4899', '#0ea5e9', '#8b5cf6', '#ef4444', '#14b8a6'];

// Model pricing display (USD per 1M tokens) — keep in sync with claudeJsonlParser.ts
const MODEL_PRICING_DISPLAY: Record<string, { input: string; cache: string; output: string }> = {
  'Opus 4.6': { input: '15.00', cache: '1.50', output: '75.00' },
  'Sonnet 4.6': { input: '3.00', cache: '0.30', output: '15.00' },
  'Sonnet 4.5': { input: '3.00', cache: '0.30', output: '15.00' },
  'Haiku 4.5': { input: '0.80', cache: '0.08', output: '4.00' },
  'Opus 3': { input: '15.00', cache: '1.50', output: '75.00' },
  'Sonnet 3.5': { input: '3.00', cache: '0.30', output: '15.00' },
  'Haiku 3.5': { input: '0.80', cache: '0.08', output: '4.00' },
  'Haiku 3': { input: '0.25', cache: '0.03', output: '1.25' },
  'default': { input: '3.00', cache: '0.30', output: '15.00' },
};
const TIME_RANGES = [
  { key: 'today', label: 'Today', days: 1 },
  { key: '7d', label: '7D', days: 7 },
  { key: '30d', label: '30D', days: 30 },
  { key: '60d', label: '60D', days: 60 },
  { key: 'all', label: 'ALL', days: 0 },
] as const;

type TimeRangeKey = typeof TIME_RANGES[number]['key'];

/* ---- Shared UI primitives ---- */

function InsightCard({ label, title, detail, badge }: { label: string; title: string; detail: string; badge?: string }) {
  return (
    <div className="flex flex-col justify-between rounded-2xl bg-white p-5 shadow-[0_1px_3px_rgba(120,113,108,0.06)] transition-shadow duration-200 hover:shadow-[0_4px_12px_rgba(120,113,108,0.09)]">
      <div className="mb-3 flex items-start justify-between gap-3">
        <p className="text-[12px] font-medium text-stone-400">{label}</p>
        {badge ? <span className="rounded-md bg-indigo-50 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-indigo-600">{badge}</span> : null}
      </div>
      <div>
        <p className="text-2xl font-extrabold tracking-tight text-stone-900">{title}</p>
        <p className="mt-1.5 text-[13px] font-medium leading-relaxed text-stone-500">{detail}</p>
      </div>
    </div>
  );
}

function KPICard({ label, value, sub, insight, accent }: { label: string; value: string; sub?: string; insight?: string; accent?: boolean }) {
  return (
    <div className="flex flex-col gap-1 p-5 rounded-2xl bg-white shadow-[0_1px_3px_rgba(120,113,108,0.06)] transition-shadow duration-200 hover:shadow-[0_4px_12px_rgba(120,113,108,0.09)]">
      <span className="text-[12px] font-medium text-stone-400">{label}</span>
      <span className={`text-3xl font-extrabold tracking-tighter font-mono mt-1 ${accent ? 'text-indigo-600' : 'text-stone-900'}`}>{value}</span>
      {sub && <span className="text-xs font-medium text-stone-400 mt-0.5">{sub}</span>}
      {insight && <div className="mt-2.5 pt-2.5 border-t border-stone-100 text-[12px] font-medium text-stone-500 leading-relaxed">{insight}</div>}
    </div>
  );
}

function Panel({ title, subtitle, children, className = '' }: { title: string; subtitle?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`flex flex-col rounded-2xl bg-white p-5 shadow-[0_1px_3px_rgba(120,113,108,0.06)] ${className}`}>
      <div className="mb-5">
        <h3 className="text-[15px] font-semibold text-stone-900 tracking-tight">{title}</h3>
        {subtitle && <p className="text-[13px] font-medium text-stone-400 mt-1">{subtitle}</p>}
      </div>
      <div className="flex-1 min-h-0">
        {children}
      </div>
    </div>
  );
}

function TooltipBox({ active, payload, label, fmt = formatTokens }: { active?: boolean; payload?: Array<{ name: string; value: number; color: string }>; label?: string; fmt?: (v: number) => string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white rounded-xl px-3.5 py-3 shadow-[0_8px_30px_rgba(120,113,108,0.12)] text-[11px] border border-stone-200/40">
      {label && <div className="text-stone-400 mb-1.5 font-medium">{label}</div>}
      {payload.map((p, i) => (
        <div key={i} className="flex items-center justify-between gap-5">
          <span className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: p.color }} />{p.name}</span>
          <span className="font-mono text-stone-700">{fmt(p.value)}</span>
        </div>
      ))}
    </div>
  );
}

function FilterTab({ options, value, onChange }: { options: readonly { key: string; label: string }[]; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center gap-0.5 p-0.5 bg-stone-100 rounded-lg">
      {options.map(o => (
        <button key={o.key} onClick={() => onChange(o.key)}
          className={`px-3 py-1.5 rounded-md text-[11px] font-semibold tracking-wide transition-all duration-200 ${value === o.key ? 'bg-stone-800 text-white shadow-sm' : 'text-stone-500 hover:text-stone-800 hover:bg-stone-50'}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function ProjectSelect({ projects, value, onChange }: { projects: string[]; value: string; onChange: (v: string) => void }) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)}
      className="bg-white border border-stone-200 rounded-lg px-3 py-1.5 text-[12px] font-semibold text-stone-800 outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 max-w-[220px]">
      <option value="">All Projects</option>
      {projects.map(p => <option key={p} value={p}>{formatProjectName(p, projects)}</option>)}
    </select>
  );
}

/* ---- Aggregation helpers ---- */

function filterByTime<T extends { date?: string; startTime?: string }>(data: T[], rangeKey: TimeRangeKey): T[] {
  if (rangeKey === 'all') return data;
  if (rangeKey === 'today') {
    const now = new Date();
    const todayStr = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
    return data.filter(d => {
      const field = d.date || d.startTime || '';
      const dt = new Date(field);
      const fieldStr = dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
      return fieldStr === todayStr;
    });
  }
  const range = TIME_RANGES.find(t => t.key === rangeKey);
  const days = range ? range.days : 30;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  return data.filter(d => {
    const field = d.date || d.startTime || '';
    return new Date(field) >= cutoff;
  });
}

function filterProjectDaily(projects: Record<string, DailyEntry[]>, project: string, range: TimeRangeKey): DailyEntry[] {
  if (!project) {
    // Merge all projects by date
    const merged: Record<string, DailyEntry> = {};
    for (const entries of Object.values(projects)) {
      for (const e of filterByTime(entries, range)) {
        if (!merged[e.date]) {
          merged[e.date] = { ...e, modelsUsed: [...e.modelsUsed], modelBreakdowns: e.modelBreakdowns.map(b => ({ ...b })) };
        } else {
          const m = merged[e.date];
          m.inputTokens += e.inputTokens;
          m.outputTokens += e.outputTokens;
          m.cacheCreationTokens += e.cacheCreationTokens;
          m.cacheReadTokens += e.cacheReadTokens;
          m.totalTokens += e.totalTokens;
          m.totalCost += e.totalCost;
          for (const b of e.modelBreakdowns) {
            const existing = m.modelBreakdowns.find(x => x.modelName === b.modelName);
            if (existing) {
              existing.inputTokens += b.inputTokens;
              existing.outputTokens += b.outputTokens;
              existing.cacheCreationTokens += b.cacheCreationTokens;
              existing.cacheReadTokens += b.cacheReadTokens;
              existing.cost += b.cost;
            } else {
              m.modelBreakdowns.push({ ...b });
            }
          }
        }
      }
    }
    return Object.values(merged).sort((a, b) => a.date.localeCompare(b.date));
  }
  return filterByTime(projects[project] || [], range);
}

/* ---- Main Dashboard ---- */

export function Dashboard() {
  const [agentsInfo, setAgentsInfo] = useState<AgentsResponse | null>(null);
  const [agentsLoading, setAgentsLoading] = useState(true);

  const [agent, setAgent] = useLocalStorageState<'claude' | 'codex' | 'openclaw' | 'opencode'>('dashboard_agent', 'claude');
  const isCodex = agent === 'codex' || agent === 'opencode';

  const [timeRange, setTimeRange] = useLocalStorageState<TimeRangeKey>('dashboard_timeRange', '30d');
  const [project, setProject] = useLocalStorageState('dashboard_project', '');
  const [showPricing, setShowPricing] = useState(false);

  // Close pricing popup on outside click
  useEffect(() => {
    if (!showPricing) return;
    const close = () => setShowPricing(false);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [showPricing]);

  // Detect available agents on mount
  useEffect(() => {
    fetchAgents()
      .then((info) => {
        setAgentsInfo(info);
        // Fallback stored agent if unavailable
        if (info.available.length > 0 && !info.available.includes(agent)) {
          setAgent(info.default as 'claude' | 'codex' | 'openclaw' | 'opencode');
        }
      })
      .catch(() => {})
      .finally(() => setAgentsLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const showAgentSwitcher = (agentsInfo?.available.length ?? 0) > 1;

  const dailyData = useCcusageData(useCallback(() => fetchDaily(agent), [agent]));
  const projectsData = useCcusageData(useCallback(() => fetchProjects(agent), [agent]));
  const blocksData = useCcusageData(useCallback(() => fetchBlocks(agent, project), [agent, project]));
  const analyticsData = useCcusageData(useCallback(() => fetchAnalytics(agent, project), [agent, project]));
  const [metric, setMetric] = useLocalStorageState<MetricMode>('dashboard_metric', 'tokens');

  const handleAgentChange = (a: 'claude' | 'codex' | 'openclaw' | 'opencode') => {
    setAgent(a);
    setProject('');
  };

  // Progressive loading: only wait for daily data to show the page shell
  const coreLoading = dailyData.loading && !dailyData.data;
  const coreError = dailyData.error && !dailyData.data;
  const isTokens = metric === 'tokens';
  const dataKey = isTokens ? 'tokens' : 'cost';

  const projectList = useMemo(() => Object.keys(projectsData.data?.projects || {}).sort(), [projectsData.data]);

  // Filtered daily data: use projectsData for per-project filtering, fallback to dailyData
  const filteredDaily = useMemo(() => {
    if (projectsData.data) {
      return filterProjectDaily(projectsData.data.projects, project, timeRange);
    }
    // Fallback while projectsData is loading: use dailyData flat entries
    if (dailyData.data) {
      return filterByTime(dailyData.data.daily, timeRange);
    }
    return [];
  }, [projectsData.data, dailyData.data, project, timeRange]);

  const isToday = timeRange === 'today';

  // Hourly model trend data (for today view, built from session blocks)
  const hourlyModelTrendData = useMemo(() => {
    if (!isToday || !blocksData.data) return [];
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const currentHour = now.getHours();
    const buckets: Record<number, Record<string, number>> = {};
    for (let h = 0; h <= currentHour; h++) buckets[h] = {};

    for (const block of blocksData.data.blocks) {
      if (block.isGap) continue;
      const start = new Date(block.startTime);
      const startStr = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
      if (startStr !== todayStr) continue;
      const hour = start.getHours();
      if (hour > currentHour) continue;
      const value = isTokens ? block.totalTokens : block.costUSD;
      const names = block.models.map(shortModelName);
      if (names.length === 0) {
        buckets[hour]['Other'] = (buckets[hour]['Other'] || 0) + value;
      } else {
        const perModel = value / names.length;
        for (const name of names) {
          buckets[hour][name] = (buckets[hour][name] || 0) + perModel;
        }
      }
    }
    return Object.entries(buckets)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([h, models]) => ({ hour: `${h.padStart(2, '0')}:00`, ...models }));
  }, [isToday, blocksData.data, isTokens]);

  // Hourly cache trend data (for today view)
  const hourlyCacheTrendData = useMemo(() => {
    if (!isToday || !blocksData.data) return [];
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const currentHour = now.getHours();
    const buckets: Record<number, { cacheRead: number; input: number }> = {};
    for (let h = 0; h <= currentHour; h++) buckets[h] = { cacheRead: 0, input: 0 };

    for (const block of blocksData.data.blocks) {
      if (block.isGap) continue;
      const start = new Date(block.startTime);
      const startStr = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
      if (startStr !== todayStr) continue;
      const hour = start.getHours();
      if (hour > currentHour) continue;
      buckets[hour].cacheRead += block.tokenCounts.cacheReadInputTokens;
      buckets[hour].input += block.tokenCounts.inputTokens;
    }
    return Object.entries(buckets)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([h, d]) => ({
        hour: `${h.padStart(2, '0')}:00`,
        cacheRead: d.cacheRead,
        input: d.input,
        hitRate: d.input > 0 ? (d.cacheRead / (d.cacheRead + d.input)) * 100 : 0,
      }));
  }, [isToday, blocksData.data]);

  // Hourly model aggregation for bar definitions (today view)
  const hourlyModelAgg = useMemo(() => {
    if (!isToday) return [];
    const map: Record<string, number> = {};
    for (const entry of hourlyModelTrendData) {
      for (const [key, val] of Object.entries(entry)) {
        if (key === 'hour') continue;
        map[key] = (map[key] || 0) + Number(val);
      }
    }
    return Object.entries(map)
      .map(([name, tokens]) => ({ name, tokens }))
      .sort((a, b) => b.tokens - a.tokens);
  }, [isToday, hourlyModelTrendData]);

  // Totals from filtered data
  const totals = useMemo(() => {
    return filteredDaily.reduce((acc, d) => ({
      inputTokens: acc.inputTokens + d.inputTokens,
      outputTokens: acc.outputTokens + d.outputTokens,
      cacheCreationTokens: acc.cacheCreationTokens + d.cacheCreationTokens,
      cacheReadTokens: acc.cacheReadTokens + d.cacheReadTokens,
      totalTokens: acc.totalTokens + d.totalTokens,
      totalCost: acc.totalCost + d.totalCost,
    }), { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0, totalCost: 0 });
  }, [filteredDaily]);

  const activeDays = useMemo(() => filteredDaily.filter(d => d.totalTokens > 0).length, [filteredDaily]);
  // Avg daily code changes from analytics
  const avgDailyChanges = useMemo(() => {
    if (!analyticsData.data || analyticsData.data.codeChangeTrend.length === 0) return null;
    const trend = analyticsData.data.codeChangeTrend;
    const totalLines = trend.reduce((s, d) => s + d.linesAdded + d.linesDeleted, 0);
    return Math.round(totalLines / trend.length);
  }, [analyticsData.data]);
  const cacheHitRate = totals.inputTokens > 0 ? (totals.cacheReadTokens / (totals.cacheReadTokens + totals.inputTokens)) * 100 : 0;
  const outputRatio = totals.inputTokens > 0 ? (totals.outputTokens / totals.inputTokens) * 100 : 0;

  // Cache Savings Data
  const cacheSavings = useMemo(() => {
    return {
      tokensSaved: totals.cacheReadTokens,
      costSaved: costSavedByCache(totals.cacheReadTokens),
      hitRate: cacheHitRate
    };
  }, [totals.cacheReadTokens, cacheHitRate]);

  // Model aggregation
  const modelAgg = useMemo(() => {
    const map: Record<string, { tokens: number; cost: number; input: number; output: number; cacheRead: number }> = {};
    for (const d of filteredDaily) {
      for (const b of d.modelBreakdowns) {
        const name = shortModelName(b.modelName);
        if (!map[name]) map[name] = { tokens: 0, cost: 0, input: 0, output: 0, cacheRead: 0 };
        map[name].tokens += b.inputTokens + b.outputTokens + b.cacheReadTokens;
        map[name].cost += b.cost;
        map[name].input += b.inputTokens;
        map[name].output += b.outputTokens;
        map[name].cacheRead += b.cacheReadTokens;
      }
    }
    return Object.entries(map).map(([name, d]) => ({ name, ...d })).sort((a, b) => b.tokens - a.tokens);
  }, [filteredDaily]);

  // Model trend data (per model per day)
  const modelTrendData = useMemo(() => {
    return filteredDaily.map(d => {
      const entry: Record<string, string | number> = { date: formatDate(d.date) };
      for (const b of d.modelBreakdowns) {
        const name = shortModelName(b.modelName);
        entry[name] = (entry[name] as number || 0) + (isTokens ? b.inputTokens + b.outputTokens + b.cacheReadTokens : b.cost);
      }
      return entry;
    });
  }, [filteredDaily, isTokens]);

  // Project pie data
  const projectPieData = useMemo(() => {
    if (!projectsData.data) return [];
    return Object.entries(projectsData.data.projects)
      .map(([path, entries]) => {
        const filtered = filterByTime(entries, timeRange);
        return {
          name: formatProjectName(path, projectList),
          full: path,
          tokens: filtered.reduce((s, e) => s + e.totalTokens, 0),
          cost: filtered.reduce((s, e) => s + e.totalCost, 0),
        };
      })
      .filter(d => d.tokens > 0)
      .sort((a, b) => b.tokens - a.tokens);
  }, [projectsData.data, timeRange]);

  // Cache trend data
  const cacheTrendData = useMemo(() => filteredDaily.map(d => ({
    date: formatDate(d.date),
    cacheRead: d.cacheReadTokens,
    input: d.inputTokens,
    hitRate: d.inputTokens > 0 ? (d.cacheReadTokens / (d.cacheReadTokens + d.inputTokens)) * 100 : 0,
  })), [filteredDaily]);

  // Output/Input trend data (for single project view)
  const outputInputTrend = useMemo(() => {
    return filteredDaily.map(d => ({
      date: formatDate(d.date),
      output: d.outputTokens,
      input: d.inputTokens,
      ratio: d.inputTokens > 0 ? (d.outputTokens / d.inputTokens) * 100 : 0,
    }));
  }, [filteredDaily]);

  // Heatmap Data (24h x 7days) — cutoff at day boundary, today only shows past hours
  const heatmapData = useMemo(() => {
    if (!blocksData.data) return null;

    // Day-level cutoff: 7D = today + past 6 days, 30D = today + past 29 days
    const now = new Date();
    const todayStr = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
    let cutoffDate: Date;
    if (timeRange === 'all') {
      cutoffDate = new Date(0); // include everything
    } else {
      const range = TIME_RANGES.find(t => t.key === timeRange);
      const daysBack = range ? range.days - 1 : 29;
      cutoffDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysBack);
    }

    const filteredBlocks = blocksData.data.blocks.filter(b => new Date(b.startTime) >= cutoffDate);

    // Create 7x24 grid
    const grid: number[][] = Array(7).fill(0).map(() => Array(24).fill(0));
    let maxVal = 0;

    for (const b of filteredBlocks) {
      if (b.isGap) continue;
      const date = new Date(b.startTime);
      const day = date.getDay();
      const hour = date.getHours();

      // For today, skip hours that haven't happened yet
      const blockDate = date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
      if (blockDate === todayStr && hour > now.getHours()) continue;

      const val = isTokens ? b.totalTokens : b.costUSD;
      grid[day][hour] += val;
      if (grid[day][hour] > maxVal) maxVal = grid[day][hour];
    }
    return { grid, maxVal };
  }, [blocksData.data, timeRange, isTokens]);


  const renderAgentSwitcher = () => (
    <div className="flex items-center gap-1 p-1 bg-stone-200/50 rounded-xl w-fit shadow-inner border border-stone-200/50">
      <button
        onClick={() => handleAgentChange('claude')}
        className={`flex items-center gap-2 px-5 py-2.5 rounded-lg text-[13px] font-bold tracking-wide transition-all duration-200 ${agent === 'claude'
          ? 'bg-white text-indigo-600 shadow-[0_1px_3px_rgba(0,0,0,0.1)] ring-1 ring-stone-900/5'
          : 'text-stone-500 hover:text-stone-800 hover:bg-stone-200/50'
          }`}
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
        Claude Code
      </button>
      <button
        onClick={() => handleAgentChange('codex')}
        className={`flex items-center gap-2 px-5 py-2.5 rounded-lg text-[13px] font-bold tracking-wide transition-all duration-200 ${agent === 'codex'
          ? 'bg-white text-emerald-600 shadow-[0_1px_3px_rgba(0,0,0,0.1)] ring-1 ring-stone-900/5'
          : 'text-stone-500 hover:text-stone-800 hover:bg-stone-200/50'
          }`}
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" /></svg>
        Codex
      </button>
      <button
        onClick={() => handleAgentChange('openclaw')}
        className={`flex items-center gap-2 px-5 py-2.5 rounded-lg text-[13px] font-bold tracking-wide transition-all duration-200 ${agent === 'openclaw'
          ? 'bg-white text-orange-600 shadow-[0_1px_3px_rgba(0,0,0,0.1)] ring-1 ring-stone-900/5'
          : 'text-stone-500 hover:text-stone-800 hover:bg-stone-200/50'
          }`}
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" /></svg>
        OpenClaw
      </button>
      <button
        onClick={() => handleAgentChange('opencode')}
        className={`flex items-center gap-2 px-5 py-2.5 rounded-lg text-[13px] font-bold tracking-wide transition-all duration-200 ${agent === 'opencode'
          ? 'bg-white text-amber-600 shadow-[0_1px_3px_rgba(0,0,0,0.1)] ring-1 ring-stone-900/5'
          : 'text-stone-500 hover:text-stone-800 hover:bg-stone-200/50'
          }`}
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" /></svg>
        OpenCode
      </button>
    </div>
  );

  if (coreLoading) {
    return (
      <div className="max-w-[1440px] mx-auto px-6 py-10">
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-6 mb-8">
          <div className="flex flex-col gap-1.5">
            <h1 className="text-3xl font-extrabold tracking-tight text-stone-900">TokenDash</h1>
          </div>
          {showAgentSwitcher && renderAgentSwitcher()}
        </div>
        <div className="skeleton h-8 w-48 rounded-lg mb-2" />
        <div className="skeleton h-4 w-72 rounded-lg mb-8" />
        <div className="grid grid-cols-3 md:grid-cols-6 gap-3 mb-6">{[...Array(6)].map((_, i) => <div key={i} className="skeleton h-20 rounded-2xl" />)}</div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4"><div className="skeleton h-72 rounded-2xl" /><div className="skeleton h-72 rounded-2xl" /></div>
      </div>
    );
  }

  if (coreError) return (
    <div className="max-w-[1440px] mx-auto px-6 py-10">
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-6 mb-8">
        <div className="flex flex-col gap-1.5">
          <h1 className="text-3xl font-extrabold tracking-tight text-stone-900">TokenDash</h1>
        </div>
        {showAgentSwitcher && renderAgentSwitcher()}
      </div>
      <div className="rounded-2xl bg-red-50 border border-red-200/60 p-5"><div className="text-red-600 text-sm font-medium">{dailyData.error}</div></div>
    </div>
  );

  if (!dailyData.data) return null;

  return (
    <div className="max-w-[1440px] mx-auto px-6 py-10">
      {/* Narrative Header & Filter Bar */}
      <div className="mb-8">
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-6 mb-6">
          <div className="flex flex-col gap-1.5">
            <h1 className="text-3xl font-extrabold tracking-tight text-stone-900">TokenDash</h1>
            <p className="text-[14px] font-medium text-stone-500 leading-relaxed">
              Monitor token consumption, costs, and cache efficiency for your AI coding assistants.
            </p>
          </div>
          {showAgentSwitcher && renderAgentSwitcher()}
        </div>

        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-6 p-4 bg-white rounded-2xl border border-stone-200/50 shadow-sm w-fit">
            <div className="flex flex-col gap-2">
              <span className="text-[11px] font-semibold text-stone-400 uppercase tracking-wider">Time range</span>
              <FilterTab options={TIME_RANGES} value={timeRange} onChange={v => setTimeRange(v as TimeRangeKey)} />
            </div>

            {projectList.length > 0 && (
              <>
                <div className="w-px h-10 bg-stone-200/60 hidden sm:block"></div>
                <div className="flex flex-col gap-2">
                  <span className="text-[11px] font-semibold text-stone-400 uppercase tracking-wider">Project</span>
                  <ProjectSelect projects={projectList} value={project} onChange={setProject} />
                </div>
              </>
            )}

            <div className="w-px h-10 bg-stone-200/60 hidden sm:block"></div>
            <div className="flex flex-col gap-2">
              <span className="text-[11px] font-semibold text-stone-400 uppercase tracking-wider">Metric</span>
              <div className="flex items-center gap-1.5">
                <FilterTab options={[{ key: 'tokens', label: 'Tokens' }, { key: 'usd', label: 'Cost' }]} value={metric} onChange={v => setMetric(v as MetricMode)} />
                {!isTokens && modelAgg.length > 0 && (
                  <div className="relative">
                    <button
                      onClick={e => { e.stopPropagation(); setShowPricing(v => !v); }}
                      className="w-6 h-6 rounded-full flex items-center justify-center text-stone-400 hover:text-indigo-600 hover:bg-indigo-50 transition-colors"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                    </button>
                    {showPricing && (
                      <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 z-50 w-[320px] bg-white rounded-xl shadow-[0_8px_30px_rgba(120,113,108,0.15)] border border-stone-200/60 p-4">
                        <div className="absolute -top-1.5 left-1/2 -translate-x-1/2 w-3 h-3 bg-white border-l border-t border-stone-200/60 rotate-45" />
                        <div className="flex items-center gap-2 mb-2">
                          <span className="text-[11px] font-bold text-stone-500 uppercase tracking-wider">Pricing Formula</span>
                        </div>
                        <div className="text-[10px] font-mono text-stone-400 bg-stone-50 rounded-lg px-2.5 py-1.5 mb-2.5 leading-relaxed">
                          Cost = (input - cached) x in_price + cached x cache_price + output x out_price
                        </div>
                        <div className="text-[10px] text-stone-400 mb-1.5 font-semibold">Per 1M tokens (USD)</div>
                        <div className="space-y-1">
                          {modelAgg.slice(0, 4).map((m, i) => {
                            const pricing = MODEL_PRICING_DISPLAY[m.name] || MODEL_PRICING_DISPLAY.default;
                            return (
                              <div key={m.name} className="flex items-center gap-1.5 text-[10px]">
                                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: C[i % C.length] }} />
                                <span className="font-semibold text-stone-600 w-20 truncate">{m.name}</span>
                                <span className="text-stone-400 font-mono">in ${pricing.input}</span>
                                <span className="text-emerald-500 font-mono">ca ${pricing.cache}</span>
                                <span className="text-stone-400 font-mono">out ${pricing.output}</span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* KPI Row */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
        <KPICard
          label={isTokens ? 'Total tokens' : 'Total cost'}
          value={isTokens ? formatTokens(totals.totalTokens) : formatUSD(totals.totalCost)}
          accent
          insight={isTokens ? 'The primary volume indicator for the selected period.' : 'Estimated spend for the selected period.'}
        />
        <KPICard
          label={isTokens ? 'Daily avg' : 'Daily avg cost'}
          value={isTokens ? formatTokens(activeDays > 0 ? totals.totalTokens / activeDays : 0) : formatUSD(activeDays > 0 ? totals.totalCost / activeDays : 0)}
          sub={`${activeDays} active days`}
          insight={isTokens ? 'Baseline for typical daily volume.' : 'Baseline for typical daily spend.'}
        />
        <KPICard label="Avg daily changes" value={avgDailyChanges !== null ? avgDailyChanges.toLocaleString() + ' lines' : '-'} insight="Average lines changed per active day." />
        <KPICard label="Cache hit" value={formatPercent(cacheHitRate)} insight="Higher hit rate reduces cost." />
        <KPICard label="Output/Input" value={formatPercent(outputRatio)} insight="Ratio of generation to context." />
      </div>

      {/* Model Trend (bar) + Cache Efficiency */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        <Panel title="Model trend" subtitle={isToday ? "Hourly breakdown from today's session blocks" : "Showing top 6 models to maintain readability"}>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={isToday ? hourlyModelTrendData : modelTrendData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e7e5e4" vertical={false} />
              <XAxis dataKey={isToday ? "hour" : "date"} tick={{ fill: '#78716c', fontSize: 10 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: '#78716c', fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={(v: number) => isTokens ? formatTokens(v) : formatUSD(v)} />
              <Tooltip content={<TooltipBox fmt={isTokens ? formatTokens : formatUSD} />} />
              <Legend wrapperStyle={{ fontSize: 11, paddingTop: 12 }} />
              {(isToday ? hourlyModelAgg : modelAgg).slice(0, 6).map((m, i) => (
                <Bar key={m.name} dataKey={m.name} stackId="1" fill={C[i % C.length]} fillOpacity={0.85} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </Panel>

        <Panel title="Cache efficiency & savings">
          <div className="flex items-center gap-6 mb-4 px-4 py-3 bg-emerald-50/50 rounded-xl border border-emerald-100/50">
            <div className="flex flex-col">
              <span className="text-[11px] font-bold text-emerald-600/70 uppercase tracking-wider mb-0.5">Est. Cost Saved</span>
              <span className="text-2xl font-black text-emerald-600 tracking-tight">{formatUSD(cacheSavings.costSaved)}</span>
            </div>
            <div className="w-px h-8 bg-emerald-200/50"></div>
            <div className="flex flex-col">
              <span className="text-[11px] font-bold text-emerald-600/70 uppercase tracking-wider mb-0.5">Tokens Saved</span>
              <span className="text-lg font-extrabold text-emerald-700/80 tracking-tight font-mono">{formatTokens(cacheSavings.tokensSaved)}</span>
            </div>
            <div className="w-px h-8 bg-emerald-200/50"></div>
            <div className="flex flex-col">
              <span className="text-[11px] font-bold text-emerald-600/70 uppercase tracking-wider mb-0.5">Avg Hit Rate</span>
              <span className="text-lg font-extrabold text-emerald-700/80 tracking-tight font-mono">{formatPercent(cacheSavings.hitRate)}</span>
            </div>
          </div>
          <ResponsiveContainer width="100%" height={180}>
            <ComposedChart data={isToday ? hourlyCacheTrendData : cacheTrendData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e7e5e4" vertical={false} />
              <XAxis dataKey={isToday ? "hour" : "date"} tick={{ fill: '#78716c', fontSize: 10 }} axisLine={false} tickLine={false} />
              <YAxis yAxisId="left" tick={{ fill: '#78716c', fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={(v: number) => formatTokens(v)} />
              <YAxis yAxisId="right" orientation="right" tick={{ fill: '#78716c', fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={(v: number) => `${v.toFixed(0)}%`} />
              <Tooltip content={<TooltipBox />} />
              <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} />
              <Area yAxisId="left" type="monotone" dataKey="cacheRead" stroke={C[5]} fill={C[5]} fillOpacity={0.08} name="Cache Read" strokeWidth={1.5} />
              <Line yAxisId="right" type="monotone" dataKey="hitRate" stroke={C[3]} strokeWidth={2} dot={false} name="Hit Rate (%)" />
            </ComposedChart>
          </ResponsiveContainer>
        </Panel>
      </div>

      {/* Non-critical request warnings */}
      {(projectsData.error || blocksData.error) && (
        <div className="mb-4 rounded-xl bg-amber-50 border border-amber-200/60 px-4 py-2.5 flex items-center gap-2 text-[12px] text-amber-700 font-medium">
          <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
          {projectsData.error && <span>Projects data unavailable</span>}
          {projectsData.error && blocksData.error && <span className="text-amber-400">·</span>}
          {blocksData.error && <span>Session data unavailable</span>}
        </div>
      )}

      {/* Model Distribution + Project Distribution */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        <Panel title="Model distribution" subtitle="Ranked by total volume">
          <ResponsiveContainer width="100%" height={260}>
            <PieChart margin={{ left: 0, right: 0, top: 0, bottom: 0 }}>
              <Pie
                data={modelAgg.slice(0, 6)}
                dataKey={dataKey}
                nameKey="name"
                cx="50%"
                cy="50%"
                innerRadius={60}
                outerRadius={90}
                paddingAngle={2}
              >
                {modelAgg.slice(0, 6).map((_, index) => (
                  <Cell key={index} fill={C[index % C.length]} fillOpacity={0.85} stroke="transparent" />
                ))}
              </Pie>
              <Tooltip content={<TooltipBox fmt={isTokens ? formatTokens : formatUSD} />} />
              <Legend layout="vertical" verticalAlign="middle" align="right" wrapperStyle={{ fontSize: 11 }} />
            </PieChart>
          </ResponsiveContainer>
        </Panel>

        {!project ? (
          projectsData.loading && !projectsData.data ? (
            <Panel title="Project distribution">
              <div className="flex items-center justify-center h-64 text-stone-400 text-[13px]">
                <svg className="animate-spin w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                Loading project data...
              </div>
            </Panel>
          ) : (
            <Panel title="Project distribution" subtitle={`Top 8 projects by ${isTokens ? 'tokens' : 'cost'}`}>
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={projectPieData.slice(0, 8)} layout="vertical" margin={{ left: 8, right: 8, top: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e7e5e4" horizontal={false} />
                  <XAxis type="number" tick={{ fill: '#78716c', fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={(v: number) => isTokens ? formatTokens(v) : formatUSD(v)} />
                  <YAxis type="category" dataKey="name" tick={{ fill: '#57534e', fontSize: 11 }} axisLine={false} tickLine={false} width={110} />
                  <Tooltip content={<TooltipBox fmt={isTokens ? formatTokens : formatUSD} />} />
                  <Bar dataKey={dataKey} radius={[0, 6, 6, 0]} maxBarSize={24}>
                    {projectPieData.slice(0, 8).map((_, index) => (
                      <Cell key={index} fill={C[index % C.length]} fillOpacity={0.85} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </Panel>
          )
        ) : project ? (
          <Panel title="Output / Input ratio" subtitle="Daily generation vs context ratio">
            <ResponsiveContainer width="100%" height={280}>
              <LineChart data={outputInputTrend}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e7e5e4" vertical={false} />
                <XAxis dataKey="date" tick={{ fill: '#78716c', fontSize: 10 }} axisLine={false} tickLine={false} />
                <YAxis yAxisId="tokens" tick={{ fill: '#78716c', fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={(v: number) => formatTokens(v)} />
                <YAxis yAxisId="ratio" orientation="right" tick={{ fill: '#78716c', fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={(v: number) => `${v.toFixed(0)}%`} />
                <Tooltip content={<TooltipBox />} />
                <Legend wrapperStyle={{ fontSize: 11, paddingTop: 12 }} />
                <Line yAxisId="tokens" type="monotone" dataKey="output" stroke={C[1]} strokeWidth={2} dot={false} name="Output" />
                <Line yAxisId="tokens" type="monotone" dataKey="input" stroke={C[0]} strokeWidth={2} dot={false} name="Input" />
                <Line yAxisId="ratio" type="monotone" dataKey="ratio" stroke={C[3]} strokeWidth={2} strokeDasharray="4 2" dot={false} name="Ratio (%)" />
              </LineChart>
            </ResponsiveContainer>
          </Panel>
        ) : null}
      </div>

      {/* 24-Hour Activity Heatmap */}
      <div className="mb-4">
        <Panel title="24-Hour Activity Heatmap" subtitle={isToday ? "Today's hourly activity distribution" : "Activity distribution by hour and day of week"}>
          {blocksData.loading && !blocksData.data ? (
            <div className="flex items-center justify-center h-48 text-stone-400 text-[13px]">
              <svg className="animate-spin w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
              Loading session data...
            </div>
          ) : heatmapData ? (
            <div className="flex flex-col w-full pt-1 pb-2">
              <div className="flex w-full gap-2">
                <div className="w-8 shrink-0 flex flex-col justify-around text-[10px] font-medium text-stone-400 pt-0.5 pb-0.5">
                  {isToday
                    ? <div className="h-[44px] flex items-center justify-center rounded bg-stone-800 text-white font-bold text-[9px]">Today</div>
                    : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, i) => <div key={d} className={`h-[22px] flex items-center justify-center rounded ${i === new Date().getDay() ? 'bg-stone-800 text-white font-bold' : ''}`}>{d}</div>)
                  }
                </div>
                <div className="flex-1 flex flex-col gap-1">
                  {(isToday ? [new Date().getDay()] : [0, 1, 2, 3, 4, 5, 6]).map(dayIdx => (
                    <div key={dayIdx} className={`flex gap-1 ${isToday ? 'h-[44px]' : 'h-[22px]'}`}>
                      {heatmapData.grid[dayIdx].map((val, hourIdx) => {
                        const opacity = heatmapData.maxVal > 0 ? 0.15 + (val / heatmapData.maxVal) * 0.85 : 0;
                        return (
                          <div
                            key={hourIdx}
                            className="flex-1 rounded-[3px] relative group transition-all hover:ring-2 hover:ring-emerald-400 hover:ring-offset-1 hover:z-10"
                            style={{ backgroundColor: val > 0 ? `rgba(16, 185, 129, ${opacity})` : '#ebedf0' }}
                          >
                            {val > 0 && (
                              <div className="absolute opacity-0 group-hover:opacity-100 z-20 bg-stone-900 text-white text-[10px] px-2 py-1 rounded bottom-full mb-1.5 left-1/2 -translate-x-1/2 pointer-events-none whitespace-nowrap shadow-lg font-mono">
                                {hourIdx}:00 - {isTokens ? formatTokens(val) + ' tokens' : formatUSD(val)}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  ))}
                </div>
              </div>
              <div className="flex ml-10 mt-1.5 text-[10px] font-medium text-stone-400">
                {[...Array(24)].map((_, i) => (
                  <div key={i} className="flex-1 text-center truncate">{i % 2 === 0 ? i : ''}</div>
                ))}
              </div>
            </div>
          ) : (
            <div className="h-48 flex items-center justify-center text-stone-400 text-sm">No session data available</div>
          )}
        </Panel>
      </div>

      {/* Section: Code Analytics (Claude Code & OpenClaw only) */}
      {!isCodex && analyticsData.data && (
        <AnalyticsSection analytics={analyticsData.data} timeRange={timeRange} />
      )}

      {/* Daily Detail Table */}
      <Panel title="Daily detail" subtitle="Recent 30 days of usage breakdown">
        <div className="overflow-x-auto">
          <table className="w-full text-[11px] whitespace-nowrap">
            <thead>
              <tr className="border-b border-stone-200">
                <th className="text-left py-3 px-4 text-stone-400 font-semibold text-[10px]">Date</th>
                <th className="text-right py-3 px-4 text-stone-400 font-semibold text-[10px]">Input</th>
                <th className="text-right py-3 px-4 text-stone-400 font-semibold text-[10px]">Output</th>
                <th className="text-right py-3 px-4 text-stone-400 font-semibold text-[10px]">Cache read</th>
                <th className="text-right py-3 px-4 text-stone-600 font-semibold text-[10px]">Total tokens</th>
                <th className="text-right py-3 px-4 text-stone-400 font-semibold text-[10px]">Cost</th>
                <th className="text-left py-3 px-4 text-stone-400 font-semibold text-[10px]">Models</th>
              </tr>
            </thead>
            <tbody>
              {[...filteredDaily].reverse().slice(0, 30).map(d => (
                <tr key={d.date} className="border-b border-stone-100 hover:bg-stone-50/60 transition-colors">
                  <td className="py-2.5 px-4 text-stone-800 font-semibold">{formatDate(d.date)}</td>
                  <td className="py-2.5 px-4 text-right font-mono text-stone-500">{formatTokens(d.inputTokens)}</td>
                  <td className="py-2.5 px-4 text-right font-mono text-stone-500">{formatTokens(d.outputTokens)}</td>
                  <td className="py-2.5 px-4 text-right font-mono text-indigo-500/70">{formatTokens(d.cacheReadTokens)}</td>
                  <td className="py-2.5 px-4 text-right font-mono font-semibold text-indigo-600">{formatTokens(d.totalTokens)}</td>
                  <td className="py-2.5 px-4 text-right font-mono font-medium text-stone-600 bg-stone-50/40">{formatUSD(d.totalCost)}</td>
                  <td className="py-2.5 px-4 text-stone-500 font-medium truncate max-w-[200px]">{d.modelsUsed.map(shortModelName).join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
