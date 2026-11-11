import './appSettings.js';
import { FALLBACK_PRICING_MODEL, getPricing, normalizePricingModel, modelCostWithFallback } from '../shared/modelPricing.js';

export const CODEX_LONG_CONTEXT_THRESHOLD = 272_000;

interface TokenCounts {
  timestamp?: string;
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

/** Normalize Codex log model labels to stable display and pricing keys. */
export function normalizeCodexModelName(model: string): string {
  const stripped = stripDateSuffix(model.trim().toLowerCase());
  return stripped === 'gpt-5.6' ? 'gpt-5.6-sol' : stripped;
}

export function isLongContextCodexRequest(inputTokens: number, model?: string): boolean {
  return inputTokens > (getPricing(model ?? 'gpt-5.6-sol')?.threshold ?? CODEX_LONG_CONTEXT_THRESHOLD);
}

/**
 * Calculate cost in USD from token counts and model pricing.
 * Long-context fields must be populated while aggregating individual requests;
 * they cannot be recovered from a summed input token total afterwards.
 */
export function calculateCost(tokens: TokenCounts, models: Set<string>): number {
  const model = normalizeCodexModelName([...models][0] ?? '');
  if (tokens.timestamp) return modelCostWithFallback(model, Math.max(0, tokens.inputTokens - tokens.cachedInputTokens), tokens.outputTokens, tokens.cachedInputTokens, 0, tokens.timestamp);
  const pricing = getModelPricing(model);

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

export function getModelPricing(model: string) {
  // 未知模型按兜底价目估算，避免静默按 $0 累加。
  const pricing = getPricing(normalizePricingModel(model)) ?? getPricing(FALLBACK_PRICING_MODEL);
  return {
    inputPer1M: pricing?.input ?? 0,
    cachedInputPer1M: pricing?.cacheRead ?? 0,
    outputPer1M: pricing?.output ?? 0,
    longContextInputPer1M: pricing?.long?.input,
    longContextCachedInputPer1M: pricing?.long?.cacheRead,
    longContextOutputPer1M: pricing?.long?.output,
  };
}
