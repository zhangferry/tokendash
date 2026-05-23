export function cacheHitRate(cacheReadTokens: number, inputTokens: number): number {
  const totalInputTokens = inputTokens + cacheReadTokens;
  if (totalInputTokens === 0) return 0;
  return (cacheReadTokens / totalInputTokens) * 100;
}

export function tokensSavedByCache(cacheReadTokens: number): number {
  return cacheReadTokens;
}

export function costSavedByCache(cacheReadTokens: number): number {
  const cacheReadCostMultiplier = 0.1;
  const inputCostPerMillion = 3.0;
  return (cacheReadTokens / 1_000_000) * inputCostPerMillion * (1 - cacheReadCostMultiplier);
}
