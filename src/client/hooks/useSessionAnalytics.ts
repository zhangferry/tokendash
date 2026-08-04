import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchSessionAnalytics } from '../api/client.js';
import type { SessionAnalyticsResponse } from '../../shared/types.js';

export interface SessionAnalyticsFilters {
  agent: string;
  project: string;
  range: string;
  model?: string;
  status?: string;
}

/** Owns request identity, pagination and stale-data retention for the Sessions tab. */
export function useSessionAnalytics(filters: SessionAnalyticsFilters, refreshVersion: number) {
  const { agent, project, range, model, status } = filters;
  const [data, setData] = useState<SessionAnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [cursor, setCursor] = useState<string | undefined>();
  const [history, setHistory] = useState<string[]>([]);
  const requestId = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    setCursor(undefined);
    setHistory([]);
  }, [agent, project, range, model, status, debouncedQuery]);

  const load = useCallback(async (refresh = false) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const result = await fetchSessionAnalytics({ agent, project, range, model, status, query: debouncedQuery, cursor, limit: 20, refresh, signal: controller.signal });
      if (id === requestId.current) setData(result);
    } catch (err) {
      if (id === requestId.current && !controller.signal.aborted) setError(err instanceof Error ? err.message : 'Unable to load session analytics');
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [agent, project, range, model, status, debouncedQuery, cursor]);

  useEffect(() => { void load(refreshVersion > 0); }, [load, refreshVersion]);
  useEffect(() => () => controllerRef.current?.abort(), []);

  const nextPage = useCallback(() => {
    if (!data?.pagination.nextCursor) return;
    setHistory(current => [...current, cursor || '']);
    setCursor(data.pagination.nextCursor || undefined);
  }, [cursor, data?.pagination.nextCursor]);
  const previousPage = useCallback(() => {
    const previous = history[history.length - 1];
    if (previous === undefined) return;
    setHistory(current => current.slice(0, -1));
    setCursor(previous || undefined);
  }, [history]);

  return { data, loading, error, query, setQuery, nextPage, previousPage, hasPreviousPage: history.length > 0, retry: () => load(true) };
}
