import { useCallback, useEffect, useRef, useState } from 'react';

import type { HourlyRange } from './aggregate.js';
import { ActivityChart } from './components/ActivityChart.js';
import { ActionButtons } from './components/ActionButtons.js';
import { CodingPlanSection } from './components/CodingPlanSection.js';
import { Header } from './components/Header.js';
import { SettingsView } from './components/SettingsView.js';
import { TrendSection } from './components/TrendSection.js';
import { UsageSection } from './components/UsageSection.js';
import { WarningIcon } from './components/icons.js';
import { hidePopover, invoke, isHosted, loadSettings, onHostEvent, openDashboard, saveSettings, setPopoverHeight } from './host.js';
import { usePopoverData } from './usePopoverData.js';
import type { Appearance, DesktopSettings } from './types.js';

const DEFAULT_SETTINGS: DesktopSettings = {
  backgroundRefreshSecs: 3_600,
  appearance: 'system',
  hourlyRange: '1d',
  launchAtLogin: false,
  lowQuotaNotifications: true,
  lowQuotaThresholdPercent: 80,
};

function asRange(value: string): HourlyRange {
  return value === '3h' || value === '15m' ? value : '1d';
}

export function App() {
  const [settings, setSettings] = useState<DesktopSettings>(DEFAULT_SETTINGS);
  const [ready, setReady] = useState(false);
  const [visible, setVisible] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [version, setVersion] = useState('');
  const panelRef = useRef<HTMLDivElement>(null);

  const range = asRange(settings.hourlyRange);
  const data = usePopoverData(settings, range, visible);

  useEffect(() => {
    if (!isHosted()) {
      // Previews in a plain browser have no settings file; the panel still
      // renders live data from the local API.
      setReady(true);
      return;
    }
    let active = true;
    void loadSettings()
      .then((loaded) => {
        if (active) setSettings(loaded);
      })
      .catch(() => undefined);
    void invoke<string>('app_version')
      .then((value) => {
        if (active) setVersion(value);
      })
      .catch(() => undefined);
    setReady(true);
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    onHostEvent('popover-visibility', (payload) => setVisible(payload === true));
    onHostEvent('popover-refresh', () => data.refreshNow());
  }, [data.refreshNow]);

  useEffect(() => {
    const root = document.documentElement;
    if (settings.appearance === 'system') {
      delete root.dataset.theme;
    } else {
      root.dataset.theme = settings.appearance;
    }
  }, [settings.appearance]);

  useEffect(() => {
    const element = panelRef.current;
    if (!element || !isHosted()) return;
    const observer = new ResizeObserver(() => {
      const height = Math.ceil(element.getBoundingClientRect().height);
      if (height > 0) void setPopoverHeight(height).catch(() => undefined);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !showSettings) {
        void hidePopover().catch(() => undefined);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [showSettings]);

  const patchSettings = useCallback((patch: Partial<DesktopSettings>) => {
    setSettings((previous) => {
      const next = { ...previous, ...patch };
      if (isHosted()) {
        void saveSettings(next)
          .then((saved) => setSettings(saved))
          .catch(() => setSettings(previous));
      }
      return next;
    });
  }, []);

  const changeRange = useCallback((next: HourlyRange) => patchSettings({ hourlyRange: next }), [patchSettings]);

  const summary = data.summary;
  const cacheRate = summary?.cacheRate ?? 0;

  return (
    <div className="panel" ref={panelRef}>
      <Header summary={summary} cacheRate={cacheRate} refreshing={data.refreshing} onRefresh={data.refreshNow} />

      {data.error ? (
        <div className="error-banner">
          <WarningIcon />
          <span>{data.error}</span>
        </div>
      ) : null}

      {data.warning && <div className="error-banner" role="status"><WarningIcon /><span>{data.warning}</span></div>}

      {showSettings ? (
        <SettingsView
          settings={settings}
          quotas={data.quotas}
          version={version}
          onPatch={patchSettings}
          onClose={() => setShowSettings(false)}
        />
      ) : data.loading || !ready ? (
        <div className="loading-line">
          <span className="spinner" />
          <span>Loading usage data…</span>
        </div>
      ) : (
        <>
          <ActivityChart base={data.buckets} realtime={data.realtimeBuckets} range={range} onRangeChange={changeRange} />
          <UsageSection summary={summary} models={data.models} />
          <TrendSection trend={data.trend} />
          <CodingPlanSection quotas={data.quotas} />
        </>
      )}

      <ActionButtons
        onOpenDashboard={() => {
          void openDashboard().catch(() => undefined);
        }}
        onOpenSettings={() => setShowSettings(true)}
      />
    </div>
  );
}