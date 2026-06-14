/**
 * Normalized quota domain types.
 *
 * These are provider-neutral. Every provider adapter converts its own
 * heterogeneous response shape into this contract so the rest of the app
 * never sees provider-specific fields.
 *
 * Mirrored on the Swift side by TokenDashSwift/Sources/TokenDash/Models/APIModels.swift.
 */

export type QuotaProviderId = 'codex' | 'claude' | 'glm' | 'minimax' | 'kimi';

/** A normalized snapshot of one provider's current quota state. */
export interface QuotaSnapshot {
  /** Stable provider id, e.g. "codex" | "claude" | "glm" | "minimax" | "kimi". */
  provider: QuotaProviderId;
  /** Human-facing name, e.g. "OpenAI Codex". */
  displayName: string;
  /** Subscription tier when known, e.g. "Pro" | "Plus" | "LEVEL_INTERMEDIATE". */
  planName?: string;
  /** ISO 8601 timestamp of the most recent successful fetch. */
  fetchedAt: string;
  /** "live" = fresh this cycle, "cached" = within ttl, "stale" = last good after a failure. */
  freshness: 'live' | 'cached' | 'stale';
  /** Independent quota windows. Never merged into one synthetic number. */
  windows: QuotaWindow[];
  /** Structured status — never carries secrets, only redacted messages. */
  status: QuotaProviderStatus;
}

/** A single independent quota window (e.g. 5-hour, weekly, MCP-monthly). */
export interface QuotaWindow {
  /** Stable per-snapshot id, e.g. "five_hour" | "weekly" | "codex_primary". */
  id: string;
  /** Human label, e.g. "5-Hour Window" | "Weekly". */
  label: string;
  /** Consumed percentage 0-100. */
  usedPercent: number;
  /** Remaining percentage 0-100 (100 - usedPercent). */
  remainingPercent: number;
  /** Absolute used value when the provider reports one. */
  used?: number;
  /** Absolute limit value when the provider reports one. */
  limit?: number;
  /** Window length in minutes (300 = 5h, 10080 = 7d). */
  durationMins?: number;
  /** ISO 8601 timestamp when this window resets. */
  resetsAt?: string;
  /** True for unlimited / boosted windows. */
  isUnlimited?: boolean;
  /** Per-model windows (MiniMax returns per-model buckets). */
  modelName?: string;
}

export type QuotaProviderState =
  | 'ok'
  | 'auth_failed'
  | 'not_configured'
  | 'upstream_unavailable'
  | 'rate_limited'
  | 'malformed_response'
  | 'timed_out'
  | 'error';

/**
 * Structured provider status. Flat shape (not a discriminated union) so it
 * round-trips cleanly through the Zod schema. Adapters populate `message`
 * only when it carries actionable detail; `state: 'ok'` omits it.
 */
export interface QuotaProviderStatus {
  state: QuotaProviderState;
  message?: string;
  category?: string;
}

/** Full API response for GET /api/quota — only configured providers appear. */
export interface QuotaResponse {
  providers: QuotaSnapshot[];
}

/** A credential proposed by the settings UI but not persisted yet. */
export interface QuotaCredentialInput {
  apiKey: string;
  baseUrl?: string;
}

/** Result of checking a proposed credential against its upstream provider. */
export interface QuotaCredentialValidation {
  provider: QuotaProviderId;
  valid: boolean;
  status: QuotaProviderStatus;
}
