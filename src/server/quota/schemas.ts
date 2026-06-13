import { z } from 'zod';

/**
 * Zod schemas for the normalized quota contract.
 *
 * Provider adapter OUTPUT is validated here before it leaves the service,
 * so the API response (and the Swift client) can always trust the shape.
 * Validation is tolerant of additive upstream fields — adapters strip those —
 * but strict on fields used in calculations.
 */

export const QuotaWindowSchema = z.object({
  id: z.string(),
  label: z.string(),
  usedPercent: z.number().min(0).max(100).default(0),
  remainingPercent: z.number().min(0).max(100).default(0),
  used: z.number().optional(),
  limit: z.number().optional(),
  durationMins: z.number().optional(),
  resetsAt: z.string().optional(),
  isUnlimited: z.boolean().optional(),
  modelName: z.string().optional(),
});

export const QuotaProviderStatusSchema = z.object({
  state: z.enum([
    'ok',
    'auth_failed',
    'not_configured',
    'upstream_unavailable',
    'rate_limited',
    'malformed_response',
    'timed_out',
    'error',
  ]),
  message: z.string().optional(),
  category: z.string().optional(),
});

export const QuotaSnapshotSchema = z.object({
  provider: z.enum(['codex', 'claude', 'glm', 'minimax', 'kimi']),
  displayName: z.string(),
  planName: z.string().optional(),
  fetchedAt: z.string(),
  freshness: z.enum(['live', 'cached', 'stale']),
  windows: z.array(QuotaWindowSchema).default([]),
  status: QuotaProviderStatusSchema,
});

export const QuotaResponseSchema = z.object({
  providers: z.array(QuotaSnapshotSchema).default([]),
});

export function validateQuotaSnapshot(data: unknown) {
  return QuotaSnapshotSchema.parse(data);
}

export function validateQuotaResponse(data: unknown) {
  return QuotaResponseSchema.parse(data);
}
