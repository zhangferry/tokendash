import type {
  QuotaCredentialInput,
  QuotaProviderId,
  QuotaSnapshot,
  QuotaProviderStatus,
} from './types.js';

/**
 * Structured quota error. Adapters throw this (not generic Error) so the
 * service can classify the status without inspecting message strings.
 * Messages must never contain secrets — they reach the API response.
 */
export class QuotaError extends Error {
  readonly status: QuotaProviderStatus;
  constructor(status: QuotaProviderStatus) {
    const msg = 'message' in status && status.message ? status.message : '';
    super(msg ? `${status.state}: ${msg}` : status.state);
    this.name = 'QuotaError';
    this.status = status;
  }
}

/**
 * One provider adapter. Responsible only for:
 *   1. detecting whether the provider is configured (credentials present)
 *   2. invoking the upstream interface
 *   3. validating the response
 *   4. converting to a normalized snapshot
 *
 * It does NOT cache, deduplicate, or time out — the service owns those.
 * Detecting a provider as configured means it appears in the dashboard;
 * fetch() may still fail with an auth/error status.
 */
export interface QuotaAdapter {
  readonly provider: QuotaProviderId;
  readonly displayName: string;

  /** True when credentials/config exist for this provider locally. Cheap, no network. */
  isConfigured(): Promise<boolean>;

  /**
   * Fetch a fresh normalized snapshot. Throws QuotaError on any failure.
   * Must NOT include secrets in any field of the returned snapshot.
   */
  fetch(options?: { credential?: QuotaCredentialInput }): Promise<QuotaSnapshot>;
}

/**
 * Registry of all known adapters, keyed by provider id.
 * Adding a quota provider = ship one adapter + register it here.
 */
export class QuotaAdapterRegistry {
  private readonly adapters = new Map<QuotaProviderId, QuotaAdapter>();

  register(adapter: QuotaAdapter): void {
    this.adapters.set(adapter.provider, adapter);
  }

  get(provider: QuotaProviderId): QuotaAdapter | undefined {
    return this.adapters.get(provider);
  }

  list(): QuotaAdapter[] {
    return Array.from(this.adapters.values());
  }
}

/** Build a baseline snapshot with shared fields filled in. */
export function baseSnapshot(
  provider: QuotaProviderId,
  displayName: string,
  opts: { planName?: string; windows?: QuotaSnapshot['windows'] } = {},
): Pick<QuotaSnapshot, 'provider' | 'displayName' | 'planName' | 'fetchedAt' | 'freshness' | 'windows'> {
  return {
    provider,
    displayName,
    planName: opts.planName,
    fetchedAt: new Date().toISOString(),
    freshness: 'live',
    windows: opts.windows ?? [],
  };
}
