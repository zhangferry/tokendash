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

export type MetricMode = 'tokens' | 'usd' | 'sessions';
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

// --- App settings ---

export type CodexDataPathKind = 'official' | 'environment' | 'custom';

export interface CodexDataPathStatus {
  path: string;
  kind: CodexDataPathKind;
  readable: boolean;
  sessionDirs: string[];
}

export interface CodexSettingsResponse {
  officialDataPaths: string[];
  environmentDataPaths: string[];
  customDataPaths: string[];
  resolvedDataPaths: CodexDataPathStatus[];
}

export interface AppSettingsResponse {
  codex: CodexSettingsResponse;
}

// --- Session analytics types ---

export type SessionStatus = 'active' | 'complete' | 'interrupted' | 'unknown';

export type SessionEventType =
  | 'user_message'
  | 'llm_call'
  | 'skill_call'
  | 'tool_call'
  | 'tool_result'
  | 'assistant_message';

export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  cost?: number;
}

export interface SessionSummary {
  id: string;
  agent: string;
  project?: string;
  /** A redacted, length-limited label derived from the first user-authored request. */
  title?: string;
  /** A deliberately short description; never the full user prompt. */
  description?: string;
  startedAt: string;
  endedAt?: string;
  status: SessionStatus;
  models: string[];
  llmCallCount: number;
  /** Present only when the source has explicit Skill semantics. */
  skillCallCount?: number;
  /** Tool calls are intentionally separate from Skills. */
  toolCallCount?: number;
  /** Present only when user messages can be parsed from this agent's logs. */
  userTurnCount?: number;
  durationMs?: number;
  totalTokens: number;
  totalCost: number;
}

export interface SessionEvent {
  id: string;
  /** Correlates a tool invocation with its eventual result when the source supports it. */
  callId?: string;
  timestamp: string;
  type: SessionEventType;
  model?: string;
  skillName?: string;
  toolName?: string;
  success?: boolean;
  usage?: SessionUsage;
  /** Safe, short event label for clients that do not need to reconstruct it. */
  summary?: string;
  /** Redacted and truncated tool/Skill arguments. Full arguments are never exposed. */
  parameterSummary?: string;
  /** Structural tool-result metadata; raw output bodies are never exposed. */
  resultSummary?: string;
  /** A redacted, bounded excerpt available as soon as one session is opened. */
  contentPreview?: string;
  /** True only when this individual event can be safely retrieved on demand. */
  contentAvailable: boolean;
  /** Returned only for a single detail request with include=content. */
  content?: string;
}

export interface SessionDetail {
  session: SessionSummary;
  events: SessionEvent[];
  indexedAt: string;
  capabilities: SessionAnalyticsCapabilities;
}

export interface SessionAnalyticsCapabilities {
  userTurns: boolean;
  skills: boolean;
  /** Tool calls are available independently of explicit Skill calls. */
  tools: boolean;
  toolResults: boolean;
  contentPreview: boolean;
}

export interface SessionAnalyticsSummary {
  sessionCount: number;
  llmCallCount: number;
  skillCallCount?: number;
  toolCallCount?: number;
  avgDurationMs?: number;
  medianDurationMs?: number;
  avgUserTurnCount?: number;
  longSessionRate?: number;
  toolSuccessRate?: number;
}

export interface SessionLlmCallTrendEntry {
  date: string;
  /** Model-keyed data is kept nested so model names cannot collide with API fields. */
  models: Record<string, number>;
  total?: number;
}

export interface SessionDistributionEntry {
  name: string;
  count: number;
}

export interface SessionDurationTurnTrendEntry {
  date: string;
  avgDurationMs?: number;
  medianDurationMs?: number;
  avgUserTurnCount?: number;
  /** Presentation-friendly aliases; duration remains available in milliseconds. */
  avgDurationMinutes?: number;
  avgUserTurns?: number;
}

export interface SessionUserTurnDistributionEntry {
  bucket: string;
  sessionCount: number;
  percentage: number;
}

export interface SessionAnalyticsResponse {
  summary: SessionAnalyticsSummary;
  llmCallTrend: SessionLlmCallTrendEntry[];
  /** Explicit Skill invocations only, for example Claude's Skill tool. */
  skillDistribution?: SessionDistributionEntry[];
  /** General tools such as Bash, Read, TaskUpdate, and MCP calls. */
  toolDistribution?: SessionDistributionEntry[];
  durationTurnTrend: SessionDurationTurnTrendEntry[];
  userTurnDistribution: SessionUserTurnDistributionEntry[];
  /** Server-owned threshold used for the “Long sessions” label. */
  longSessionThreshold?: number;
  sessions: SessionSummary[];
  pagination: {
    nextCursor?: string;
    totalCount?: number;
  };
  capabilities: SessionAnalyticsCapabilities;
}
