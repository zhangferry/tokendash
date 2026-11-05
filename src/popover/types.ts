import type { QuotaSnapshot } from '../server/quota/types.js';

/** `system` | `light` | `dark`. */
export type Appearance = 'system' | 'light' | 'dark';

/** Desktop-only preferences, owned by the Rust shell (`~/.tokendash/desktop-settings.json`). */
export interface DesktopSettings {
  backgroundRefreshSecs: number;
  appearance: Appearance;
  /** `1d` | `3h` | `15m` */
  hourlyRange: string;
  launchAtLogin: boolean;
  lowQuotaNotifications: boolean;
  lowQuotaThresholdPercent: number;
}

export const REFRESH_CHOICES: Array<{ secs: number; label: string }> = [
  { secs: 600, label: '10 min' },
  { secs: 1_800, label: '30 min' },
  { secs: 3_600, label: '1 hour (Low Power)' },
];

export const APPEARANCE_CHOICES: Array<{ value: Appearance; label: string }> = [
  { value: 'system', label: 'Match System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

export interface TodaySummary {
  tokens: number;
  cost: number;
  costAvailable?: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens?: number;
  cacheRate: number;
}

export interface ModelRow {
  name: string;
  tokens: number;
  cost: number;
  costAvailable?: boolean;
}

export interface TrendPoint {
  date: string;
  tokens: number;
  cost: number;
  costAvailable?: boolean;
}

export type { QuotaSnapshot };