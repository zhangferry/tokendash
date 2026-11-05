import { useCallback, useEffect, useRef, useState } from 'react';

import type { BlocksResponse, DailyResponse } from '../shared/types.js';
import type { QuotaSnapshot } from '../server/quota/types.js';
import { getAgents, getBlocks, getDaily, getQuota } from './api.js';
import { aggregate, computeBuckets, realtimeWindow, REALTIME_REFRESH_MS } from './aggregate.js';
import type { HourlyRange, TimeBucket } from './aggregate.js';
import { notify } from './host.js';
import { shortModelName, todayString } from './format.js';
import type { DesktopSettings, ModelRow, TodaySummary, TrendPoint } from './types.js';

/** Detail cadence while the panel is open, matching the macOS active mode. */
const ACTIVE_DETAIL_INTERVAL_MS = 60_000;
/** Panel-open refresh throttle: 30 minutes for the Today range, 5 minutes for the fine ranges. */
const OPEN_THROTTLE_MS = 30 * 60_000;
const FINE_OPEN_THROTTLE_MS = 5 * 60_000;

export interface PopoverData {
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  warning: string | null;
  summary: TodaySummary | null;
  models: ModelRow[];
  trend: TrendPoint[];
  buckets: TimeBucket[];
  realtimeBuckets: TimeBucket[];
  quotas: QuotaSnapshot[];
  refreshNow: () => void;
}

interface Derived {
  summary: TodaySummary | null;
  models: ModelRow[];
  trend: TrendPoint[];
  buckets: TimeBucket[];
}

export function derivePopoverData(runs: DailyResponse[], blocks: BlocksResponse[], now: Date, incomplete = false): Derived {
  const today = todayString(now);
  let tokens = 0;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let costAvailable = !incomplete;
  let cost = 0;
  let sawToday = false;

  for (const run of runs) {
    const entry = run.daily.find((candidate) => candidate.date === today);
    if (!entry) continue;
    sawToday = true;
    tokens += entry.totalTokens;
    input += entry.inputTokens;
    output += entry.outputTokens;
    cacheRead += entry.cacheReadTokens;
    cacheWrite += entry.cacheCreationTokens;
    costAvailable &&= entry.costAvailable !== false;
    cost += entry.totalCost;
  }

  const cacheDenominator = input + cacheRead + cacheWrite;
  const summary: TodaySummary | null = sawToday
    ? {
        tokens,
        cost,
        costAvailable,
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        cacheRate: cacheDenominator > 0 ? (cacheRead / cacheDenominator) * 100 : 0,
      }
    : null;

  const modelTotals = new Map<string, { tokens: number; cost: number; costAvailable: boolean }>();
  for (const run of runs) {
    const entry = run.daily.find((candidate) => candidate.date === today);
    if (!entry) continue;
    for (const breakdown of entry.modelBreakdowns ?? []) {
      const name = shortModelName(breakdown.modelName);
      const totals = modelTotals.get(name) ?? { tokens: 0, cost: 0, costAvailable: !incomplete };
      totals.tokens += breakdown.totalTokens ?? breakdown.inputTokens + breakdown.outputTokens + breakdown.cacheReadTokens + breakdown.cacheCreationTokens;
      totals.costAvailable &&= breakdown.costAvailable !== false;
      totals.cost += breakdown.cost;
      modelTotals.set(name, totals);
    }
  }
  const models: ModelRow[] = [...modelTotals.entries()]
    .map(([name, totals]) => ({ name, tokens: totals.tokens, cost: totals.cost, costAvailable: totals.costAvailable }))
    .sort((left, right) => right.tokens - left.tokens)
    .slice(0, 5);

  const trendTotals = new Map<string, { tokens: number; cost: number; costAvailable: boolean }>();
  for (const run of runs) {
    for (const entry of run.daily) {
      const totals = trendTotals.get(entry.date) ?? { tokens: 0, cost: 0, costAvailable: !incomplete };
      totals.tokens += entry.totalTokens;
      totals.cost += entry.totalCost;
      totals.costAvailable &&= entry.costAvailable !== false;
      trendTotals.set(entry.date, totals);
    }
  }
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const trend: TrendPoint[] = [];
  for (let offset = 6; offset >= 0; offset -= 1) {
    const day = new Date(start.getTime() - offset * 24 * 3600_000);
    const key = todayString(day);
    const totals = trendTotals.get(key) ?? { tokens: 0, cost: 0, costAvailable: !incomplete };
    trend.push({ date: key, tokens: totals.tokens, cost: totals.cost, costAvailable: totals.costAvailable });
  }

  return { summary, models, trend, buckets: computeBuckets(blocks, now).buckets };
}

/** Keep each source internally consistent and retain failures for a visible partial-data notice. */
export async function loadPopoverUsage(sources: string[], refresh: boolean) {
  const results = await Promise.allSettled(sources.map(async source => {
    const [daily, blocks] = await Promise.all([getDaily(source, refresh), getBlocks(source, '5m', refresh)]);
    return { daily, blocks };
  }));
  const daily: DailyResponse[] = [];
  const blocks: BlocksResponse[] = [];
  const sourceErrors: Array<{ agent: string; message: string }> = [];
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      daily.push(result.value.daily);
      blocks.push(result.value.blocks);
      sourceErrors.push(...(result.value.daily.sourceErrors ?? []), ...(result.value.blocks.sourceErrors ?? []));
    } else sourceErrors.push({ agent: sources[index], message: result.reason instanceof Error ? result.reason.message : String(result.reason) });
  });
  if (sources.length > 0 && daily.length === 0) throw new Error(sourceErrors.map(error => `${error.agent}: ${error.message}`).join('; '));
  return { daily, blocks, sourceErrors };
}

/** Fires one desktop notification per provider window that first crosses the threshold. */
export function evaluateLowQuota(
  quotas: QuotaSnapshot[],
  settings: DesktopSettings,
  alerted: Set<string>,
): Array<{ title: string; body: string }> {
  if (!settings.lowQuotaNotifications) return [];
  const messages: Array<{ title: string; body: string }> = [];
  for (const quota of quotas) {
    if (quota.status.state !== 'ok') continue;
    for (const window of quota.windows) {
      const key = `${quota.provider}:${window.id}`;
      const below = !window.isUnlimited && window.remainingPercent < settings.lowQuotaThresholdPercent;
      if (!below) {
        alerted.delete(key);
        continue;
      }
      if (alerted.has(key)) continue;
      alerted.add(key);
      messages.push({
        title: `${quota.displayName} quota low`,
        body: `${window.label}: ${Math.round(window.usedPercent)}% used — ${Math.round(window.remainingPercent)}% left`,
      });
    }
  }
  return messages;
}

export function usePopoverData(settings: DesktopSettings, range: HourlyRange, visible: boolean): PopoverData {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [summary, setSummary] = useState<TodaySummary | null>(null);
  const [models, setModels] = useState<ModelRow[]>([]);
  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [buckets, setBuckets] = useState<TimeBucket[]>([]);
  const [realtimeBuckets, setRealtimeBuckets] = useState<TimeBucket[]>([]);
  const [quotas, setQuotas] = useState<QuotaSnapshot[]>([]);

  const agentsRef = useRef<string[]>([]);
  const alertedRef = useRef<Set<string>>(new Set());
  const lastUpdateRef = useRef<number | null>(null);
  const inFlightRef = useRef(false);
  const settingsRef = useRef(settings);
  const rangeRef = useRef(range);
  settingsRef.current = settings;
  rangeRef.current = range;

  const load = useCallback(async (forceRefresh: boolean, forceQuota: boolean, record = true) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setRefreshing(true);
    try {
      const agents = agentsRef.current.length > 0 ? agentsRef.current : await getAgents();
      if (agents.length > 0) agentsRef.current = agents;
      const sources = agents.length > 0 ? agents : ['claude'];

      const { daily, blocks, sourceErrors } = await loadPopoverUsage(sources, forceRefresh);
      const derived = derivePopoverData(daily, blocks, new Date(), sourceErrors.length > 0);
      setWarning(sourceErrors.length ? `Partial data: ${[...new Set(sourceErrors.map(error => error.agent))].join(', ')} unavailable` : null);

      // Stale-while-revalidate: a warm-up response without today's data must not
      // blank the chart the user is looking at.
      setSummary(derived.summary);
      setModels(derived.models);
      setTrend(derived.trend);
      setBuckets((previous) => {
        const sameGranularity = previous[0]?.minutes === derived.buckets[0]?.minutes;
        const derivedEmpty = derived.buckets.every((bucket) => bucket.tokens === 0);
        const previousHasTokens = previous.some((bucket) => bucket.tokens > 0);
        return derivedEmpty && sameGranularity && previousHasTokens ? previous : derived.buckets;
      });
      setError(null);
      if (record) lastUpdateRef.current = Date.now();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      inFlightRef.current = false;
      setRefreshing(false);
      setLoading(false);
    }

    // Quota never blocks the detail paint; upstream calls can take seconds.
    try {
      const response = await getQuota(forceQuota);
      setQuotas(response.providers);
      for (const message of evaluateLowQuota(response.providers, settingsRef.current, alertedRef.current)) {
        void notify(message.title, message.body).catch(() => undefined);
      }
    } catch {
      // Quota is optional detail: a failing provider or route keeps the last view.
    }
  }, []);

  const loadRealtime = useCallback(async () => {
    const sources = agentsRef.current.length > 0 ? agentsRef.current : ['claude'];
    const now = new Date();
    const responses = await Promise.all(
      sources.map((source) => getBlocks(source, '1m', false).catch(() => null)),
    );
    const present = responses.filter((response): response is BlocksResponse => response !== null);
    if (present.length !== sources.length) setWarning(`Realtime data incomplete: ${sources.filter((_, index) => responses[index] === null).join(', ')} unavailable`);
    if (present.length === 0) return;
    const aggregation = aggregate(present, now, 1, realtimeWindow(now));
    if (!aggregation.granularityMatched) return;
    setRealtimeBuckets(aggregation.buckets);
  }, []);

  useEffect(() => {
    if (!visible) return;
    const throttle = range === '1d' ? OPEN_THROTTLE_MS : FINE_OPEN_THROTTLE_MS;
    const since = lastUpdateRef.current === null ? Number.POSITIVE_INFINITY : Date.now() - lastUpdateRef.current;
    void load(since >= throttle, false);
  }, [visible, load, range]);

  useEffect(() => {
    if (!visible) return;
    const timer = window.setInterval(() => {
      void load(true, false);
    }, ACTIVE_DETAIL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [visible, load]);

  const ensureRealtime = useCallback(() => {
    void loadRealtime();
  }, [loadRealtime]);

  useEffect(() => {
    if (!visible || range !== '15m') return;
    void loadRealtime();
    const timer = window.setInterval(() => void loadRealtime(), REALTIME_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [visible, range, loadRealtime]);

  const refreshNow = useCallback(() => {
    void load(true, true);
    if (rangeRef.current === '15m') void loadRealtime();
  }, [load, loadRealtime]);

  return {
    loading,
    refreshing,
    error,
    warning,
    summary,
    models,
    trend,
    buckets,
    realtimeBuckets,
    quotas,
    refreshNow,
  };
}

export type { HourlyRange };