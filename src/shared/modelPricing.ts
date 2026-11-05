import amax from './amaxPricing.json' with { type: 'json' };

export interface ModelPricing {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  threshold?: number;
  long?: ModelPricing;
  peak?: ModelPricing;
}

export const GO_PRICING_SOURCE = 'https://opencode.ai/v2/docs/console/go/';
let exchangeRate = 6;

export function setPricingExchangeRate(rate: number): void {
  if (!Number.isFinite(rate) || rate <= 0) throw new Error('Exchange rate must be a finite number greater than zero.');
  exchangeRate = rate;
}

export function getPricingExchangeRate(): number {
  return exchangeRate;
}

// 价格单位为美元／百万 token；Go 价格按用户指定规则跨供应商匹配。
const PRICES: Record<string, ModelPricing> = {
  'glm-5.3-flash': { input: 0.15, output: 0.5, cacheRead: 0.03 },
  'glm-5.3': { input: 1.4, output: 4.4, cacheRead: 0.26 },
  'glm-5.2': { input: 1.4, output: 4.4, cacheRead: 0.26 },
  'kimi-k3': { input: 3, output: 15, cacheRead: 0.3 },
  'kimi-k2.7-code': { input: 0.95, output: 4, cacheRead: 0.19 },
  'longcat-2.0': { input: 0.3, output: 1.2, cacheRead: 0.006 },
  'longcat-2.5-preview-free': { input: 0, output: 0, cacheRead: 0 },
  'beam-free': { input: 0, output: 0, cacheRead: 0 },
  'step-5-preview': { input: 1, output: 2.7, cacheRead: 0.1 },
  'mimo-v2.6-flash': { input: 0.14, output: 0.28, cacheRead: 0.0028 },
  'mimo-v2.6-pro': { input: 0.435, output: 0.87, cacheRead: 0.003625 },
  'mimo-v2.5': { input: 0.14, output: 0.28, cacheRead: 0.0028 },
  'mimo-v2.5-pro': { input: 0.435, output: 0.87, cacheRead: 0.003625 },
  'minimax-m3': { input: 0.3, output: 1.2, cacheRead: 0.06 },
  'muse-spark-1.3-contributor': { input: 0.1, output: 0.2, cacheRead: 0.002 },
  'muse-spark-1.2-contributor': { input: 0.1, output: 0.2, cacheRead: 0.002 },
  'qwen3.8-max': { input: 2, output: 6, cacheRead: 0.25, cacheWrite: 2.5 },
  'qwen3.8-flash': { input: 0.15, output: 0.47, cacheRead: 0.016, cacheWrite: 0.2 },
  'qwen3.7-plus': { input: 0.4, output: 1.6, cacheRead: 0.04, cacheWrite: 0.5, threshold: 256000, long: { input: 1.2, output: 4.8, cacheRead: 0.12, cacheWrite: 1.5 } },
  'deepseek-v4.1-flash': { input: 0.15, output: 0.6, cacheRead: 0.003, peak: { input: 0.3, output: 1.2, cacheRead: 0.006 } },
  'deepseek-v4-pro': { input: 0.66, output: 1.98, cacheRead: 0.022, peak: { input: 1.32, output: 3.96, cacheRead: 0.044 } },
  'hy4-preview': { input: 0.834, output: 2.501, cacheRead: 0.042 },
  'hy3': { input: 0.14, output: 0.58, cacheRead: 0.035 },
  'space-bunny': { input: 0.15, output: 0.6, cacheRead: 0.03 },
  'grok-4.7': { input: 2, output: 6, cacheRead: 0.5, threshold: 200000, long: { input: 4, output: 12, cacheRead: 1 } },
  'gpt-6-luna': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, threshold: 272000, long: { input: 0.2, output: 0.75, cacheRead: 0.02, cacheWrite: 0.25 } },
  'gpt-5.6-luna': { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25, threshold: 272000, long: { input: 0.4, output: 1.8, cacheRead: 0.04, cacheWrite: 0.5 } },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, threshold: 100000, long: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 } },
  'gemini-4-argon-contributor': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-sonnet-4-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-sonnet-4': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-opus-4': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  'claude-3-5-sonnet': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-3-5-haiku': { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  'claude-3-opus': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-3-haiku': { input: 0.25, output: 1.25, cacheRead: 0.03, cacheWrite: 0.3 },
  'gpt-5.6-sol': { input: 5, output: 30, cacheRead: 0.5, threshold: 272000, long: { input: 10, output: 45, cacheRead: 1 } },
  'gpt-5.6-terra': { input: 2.5, output: 15, cacheRead: 0.25, threshold: 272000, long: { input: 5, output: 22.5, cacheRead: 0.5 } },
  'gpt-5.5': { input: 5, output: 30, cacheRead: 0.5 },
  'gpt-5.4': { input: 2.5, output: 15, cacheRead: 0.25 },
  'gpt-5.4-mini': { input: 0.75, output: 4.5, cacheRead: 0.075 },
};

export function normalizePricingModel(model: string): string {
  const name = model.trim().toLowerCase().split('/').pop()!
    .replace(/-\d{4}-\d{2}-\d{2}$/, '').replace(/-\d{8}$/, '')
    .replace(/\s+/g, '-');
  return name === 'gpt-5.6' ? 'gpt-5.6-sol' : name;
}

export function getPricing(model: string, contextTokens = 0, timestamp?: string | number): ModelPricing | undefined {
  const name = normalizePricingModel(model);
  const native = (amax.prices as Record<string, ModelPricing>)[name];
  const toUSD = (price: ModelPricing): ModelPricing => ({
    ...price, input: price.input / exchangeRate, output: price.output / exchangeRate,
    ...(price.cacheRead === undefined ? {} : { cacheRead: price.cacheRead / exchangeRate }),
    ...(price.cacheWrite === undefined ? {} : { cacheWrite: price.cacheWrite / exchangeRate }),
    ...(price.long ? { long: toUSD(price.long) } : {}),
  });
  const pricing = PRICES[name] ?? (native ? toUSD(native) : undefined);
  if (!pricing) return undefined;
  if (pricing.long && contextTokens > pricing.threshold!) return pricing.long;
  if (pricing.peak && timestamp !== undefined) {
    const date = new Date(timestamp);
    const hour = date.getUTCHours();
    const weekday = date.getUTCDay();
    if (weekday >= 1 && weekday <= 5 && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10))) return pricing.peak;
  }
  return pricing;
}

export function modelCost(model: string, input: number, output: number, cacheRead: number, cacheWrite = 0, timestamp?: string | number): number | undefined {
  const pricing = getPricing(model, input + cacheRead + cacheWrite, timestamp);
  if (!pricing || (cacheRead > 0 && pricing.cacheRead === undefined) || (cacheWrite > 0 && pricing.cacheWrite === undefined) || (pricing.peak && timestamp === undefined)) return undefined;
  return (input * pricing.input + output * pricing.output + cacheRead * (pricing.cacheRead ?? 0) + cacheWrite * (pricing.cacheWrite ?? 0)) / 1_000_000;
}
