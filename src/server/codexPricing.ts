/**
 * Codex token pricing configuration.
 *
 * Pricing formula:
 *   cost = short_non_cached_input * input_rate
 *        + short_cached_input * cached_rate
 *        + short_output * output_rate
 *        + long_non_cached_input * long_input_rate
 *        + long_cached_input * long_cached_rate
 *        + long_output * long_output_rate
 *
 * Reasoning tokens are NOT billed separately (included in outputTokens).
 *
 * Update rates from https://openai.com/api/pricing/ when models change.
 * All prices are USD per 1M tokens.
 */

interface ModelPricing {
  inputPer1M: number;
  cachedInputPer1M: number;
  outputPer1M: number;
  longContextInputPer1M?: number;
  longContextCachedInputPer1M?: number;
  longContextOutputPer1M?: number;
}

export const CODEX_LONG_CONTEXT_THRESHOLD = 272_000;

const MODEL_PRICING: Record<string, ModelPricing> = {
  // GPT-5.6 short-context standard-tier rates. The bare gpt-5.6 alias resolves
  // to gpt-5.6-sol in normalizeCodexModelName().
  'gpt-5.6-sol': {
    inputPer1M: 5.00,
    cachedInputPer1M: 0.50,
    outputPer1M: 30.00,
    longContextInputPer1M: 10.00,
    longContextCachedInputPer1M: 1.00,
    longContextOutputPer1M: 45.00,
  },
  'gpt-5.6-terra': {
    inputPer1M: 2.50,
    cachedInputPer1M: 0.25,
    outputPer1M: 15.00,
    longContextInputPer1M: 5.00,
    longContextCachedInputPer1M: 0.50,
    longContextOutputPer1M: 22.50,
  },
  'gpt-5.6-luna': {
    inputPer1M: 1.00,
    cachedInputPer1M: 0.10,
    outputPer1M: 6.00,
    longContextInputPer1M: 2.00,
    longContextCachedInputPer1M: 0.20,
    longContextOutputPer1M: 9.00,
  },
  'gpt-5.5': {
    inputPer1M: 5.00,
    cachedInputPer1M: 0.50,
    outputPer1M: 30.00,
  },
  'gpt-5.4': {
    inputPer1M: 2.50,
    cachedInputPer1M: 0.25,
    outputPer1M: 15.00,
  },
  'gpt-5.4-mini': {
    inputPer1M: 0.75,
    cachedInputPer1M: 0.075,
    outputPer1M: 4.50,
  },
};

const DEFAULT_PRICING: ModelPricing = {
  inputPer1M: 2.50,
  cachedInputPer1M: 0.25,
  outputPer1M: 15.00,
};

interface TokenCounts {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  longContextInputTokens?: number;
  longContextCachedInputTokens?: number;
  longContextOutputTokens?: number;
}

function stripDateSuffix(model: string): string {
  return model
    .replace(/-\d{4}-\d{2}-\d{2}$/, '')
    .replace(/-\d{8}$/, '');
}

/** Normalize Codex log model labels to pricing keys. */
export function normalizeCodexModelName(model: string): string {
  const stripped = stripDateSuffix(model.trim());
  if (stripped === 'gpt-5.6') return 'gpt-5.6-sol';
  return stripped;
}

/** Return whether one raw Codex request should use long-context pricing. */
export function isLongContextCodexRequest(inputTokens: number): boolean {
  return inputTokens > CODEX_LONG_CONTEXT_THRESHOLD;
}

/**
 * Calculate cost in USD from Codex token counts and model pricing.
 * Long-context fields must be populated while aggregating individual requests;
 * they cannot be recovered from a summed input token total afterwards.
 */
export function calculateCost(tokens: TokenCounts, models: Set<string>): number {
  const model = normalizeCodexModelName([...models][0] ?? '');
  const pricing = MODEL_PRICING[model] ?? DEFAULT_PRICING;

  const longInput = Math.min(tokens.longContextInputTokens ?? 0, tokens.inputTokens);
  const longCached = Math.min(tokens.longContextCachedInputTokens ?? 0, tokens.cachedInputTokens, longInput);
  const longOutput = Math.min(tokens.longContextOutputTokens ?? 0, tokens.outputTokens);

  const shortInput = Math.max(tokens.inputTokens - longInput, 0);
  const shortCached = Math.min(Math.max(tokens.cachedInputTokens - longCached, 0), shortInput);
  const shortOutput = Math.max(tokens.outputTokens - longOutput, 0);

  const shortNonCachedInput = Math.max(shortInput - shortCached, 0);
  const longNonCachedInput = Math.max(longInput - longCached, 0);

  const longInputRate = pricing.longContextInputPer1M ?? pricing.inputPer1M;
  const longCachedRate = pricing.longContextCachedInputPer1M ?? pricing.cachedInputPer1M;
  const longOutputRate = pricing.longContextOutputPer1M ?? pricing.outputPer1M;

  const inputCost = (shortNonCachedInput / 1_000_000) * pricing.inputPer1M;
  const cachedCost = (shortCached / 1_000_000) * pricing.cachedInputPer1M;
  const outputCost = (shortOutput / 1_000_000) * pricing.outputPer1M;
  const longInputCost = (longNonCachedInput / 1_000_000) * longInputRate;
  const longCachedCost = (longCached / 1_000_000) * longCachedRate;
  const longOutputCost = (longOutput / 1_000_000) * longOutputRate;

  return inputCost + cachedCost + outputCost + longInputCost + longCachedCost + longOutputCost;
}

export function getModelPricing(model: string): ModelPricing {
  return MODEL_PRICING[normalizeCodexModelName(model)] ?? DEFAULT_PRICING;
}
