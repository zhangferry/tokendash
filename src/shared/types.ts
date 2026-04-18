export interface ModelBreakdown {
  modelName: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  cost: number;
}

export interface DailyEntry {
  date: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  totalCost: number;
  modelsUsed: string[];
  modelBreakdowns: ModelBreakdown[];
}

export interface Totals {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  totalCost: number;
}

export interface DailyResponse {
  daily: DailyEntry[];
  totals: Totals;
}

export interface MonthlyResponse {
  daily: DailyEntry[];
  totals: Totals;
}

export interface SessionResponse {
  daily: DailyEntry[];
  totals: Totals;
}

export interface ProjectsResponse {
  projects: Record<string, DailyEntry[]>;
}

export interface BlockEntry {
  id: string;
  startTime: string;
  endTime: string;
  actualEndTime: string | null;
  isActive: boolean;
  isGap: boolean;
  entries: number;
  tokenCounts: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
  };
  totalTokens: number;
  costUSD: number;
  models: string[];
}

export interface BlocksResponse {
  blocks: BlockEntry[];
}

export type MetricMode = 'tokens' | 'usd';
export type GranularityMode = 'day' | 'hour';

// --- Analytics types (Claude Code & OpenClaw only) ---

export interface ToolUsageEntry {
  name: string;
  count: number;
}

export interface DailyCodeChange {
  date: string;
  linesAdded: number;
  linesDeleted: number;
  netChange: number;
  filesModified: number;
}

export interface DailyToolCall {
  date: string;
  [toolName: string]: string | number;
}

export interface ProductivityKPIs {
  avgLinesPerEdit: number;
  filesModifiedPerDay: number;
  addDeleteRatio: number;
  totalEdits: number;
  totalFilesModified: number;
  activeDaysWithEdits: number;
}

export interface AnalyticsResponse {
  codeChangeTrend: DailyCodeChange[];
  toolUsageDistribution: ToolUsageEntry[];
  productivityKPIs: ProductivityKPIs;
  toolCallTrend: DailyToolCall[];
}
