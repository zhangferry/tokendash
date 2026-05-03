import type { BlockEntry } from '../../shared/types.js';

export interface HourlyConsumptionBucket {
  hour: number;
  label: string;
  tokens: number;
  cost: number;
  isCurrentHour: boolean;
  isFutureHour: boolean;
}

export interface HourlyConsumptionSummary {
  buckets: HourlyConsumptionBucket[];
  maxValue: number;
  peakHour: number;
}

function dateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function buildHourlyConsumption(blocks: BlockEntry[], now = new Date()): HourlyConsumptionSummary {
  const todayKey = dateKey(now);
  const currentHour = now.getHours();
  const buckets: HourlyConsumptionBucket[] = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    label: `${String(hour).padStart(2, '0')}:00`,
    tokens: 0,
    cost: 0,
    isCurrentHour: hour === currentHour,
    isFutureHour: hour > currentHour,
  }));

  for (const block of blocks) {
    if (block.isGap) continue;

    const start = new Date(block.startTime);
    if (dateKey(start) !== todayKey) continue;

    const bucket = buckets[start.getHours()];
    bucket.tokens += block.totalTokens;
    bucket.cost += block.costUSD;
  }

  let maxValue = 0;
  let peakHour = 0;
  for (const bucket of buckets) {
    if (bucket.tokens > buckets[peakHour].tokens) peakHour = bucket.hour;
    maxValue = Math.max(maxValue, bucket.tokens, bucket.cost);
  }

  return {
    buckets,
    maxValue,
    peakHour,
  };
}
