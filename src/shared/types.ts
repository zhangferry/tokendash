/** False means numeric cost is only the known, priced subtotal. */
export interface CostAvailability {
  costAvailable?: boolean;
}

export interface SourceError {
  agent: string;
  message: string;
}

export interface SourceDiagnostics {
  sourceErrors?: SourceError[];
}

export interface ModelBreakdown extends CostAvailability {
  totalTokens?: number;
  modelName: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  cost: number;
  /** 估算的 token 数（provider 未返回 usage，由消息内容推得），其余为真实上报值 */
  estimatedTokens: number;
}

export interface DailyEntry extends CostAvailability {
  date: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  totalCost: number;
  modelsUsed: string[];
  modelBreakdowns: ModelBreakdown[];
  /** 当日 totalTokens 中来自估算的部分 */
  estimatedTokens: number;
}

export interface Totals extends CostAvailability {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  totalCost: number;
  /** totalTokens 中来自估算的部分 */
  estimatedTokens: number;
}

export interface DailyResponse extends SourceDiagnostics {
  daily: DailyEntry[];
  totals: Totals;
}

export interface MonthlyResponse extends SourceDiagnostics {
  daily: DailyEntry[];
  totals: Totals;
}

export interface SessionResponse extends SourceDiagnostics {
  daily: DailyEntry[];
  totals: Totals;
}

export interface ProjectsResponse extends SourceDiagnostics {
  projects: Record<string, DailyEntry[]>;
}

export interface BlockEntry extends CostAvailability {
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

export interface BlocksResponse extends SourceDiagnostics {
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

export interface AnalyticsResponse extends SourceDiagnostics {
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
  billing?: { exchangeRate: number };
  codex: CodexSettingsResponse;
}

// --- Session analytics types ---

export type SessionStatus = 'active' | 'complete' | 'interrupted' | 'unknown';

export type SessionEventType =
  | 'input_context'
  | 'user_message'
  | 'llm_call'
  | 'skill_call'
  | 'tool_call'
  | 'tool_result'
  | 'assistant_message';

export interface SessionUsage extends CostAvailability {
  cacheWriteTokens?: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  cost?: number;
}

export interface SessionSummary extends CostAvailability {
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
  /** Present when the source has explicit or process-inferred Skill semantics. */
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
  /** Input supplied around the human request without being authored as that request. */
  inputKind?: 'system' | 'developer' | 'runtime';
  /** Human-readable source section such as Permissions, Skills, or AGENTS.md. */
  contextLabel?: string;
  model?: string;
  skillName?: string;
  /** Distinguishes native Skill events from conservative process inference. */
  skillOrigin?: 'explicit' | 'inferred';
  toolName?: string;
  success?: boolean;
  usage?: SessionUsage;
  /** Safe, short event label for clients that do not need to reconstruct it. */
  summary?: string;
  /** Delivery phase for a visible agent message when the local transcript provides it. */
  phase?: 'commentary' | 'final_answer';
  /** Redacted and truncated tool/Skill arguments. Full arguments are never exposed. */
  parameterSummary?: string;
  /** Structural tool-result metadata; raw output bodies are never exposed. */
  resultSummary?: string;
  /** A redacted, bounded excerpt available as soon as one session is opened. */
  contentPreview?: string;
  /** True only when this individual event can be safely retrieved on demand. */
  contentAvailable: boolean;
  /** True when a source record exceeded the bounded detail payload. */
  contentTruncated?: boolean;
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
  /** How Skill calls were derived when `skills` is available. */
  skillSemantics?: 'explicit' | 'inferred' | 'mixed';
  /** Tool calls are available independently of explicit Skill calls. */
  tools: boolean;
  toolResults: boolean;
  contentPreview: boolean;
}

export interface SessionAnalyticsSummary extends CostAvailability {
  totalTokens?: number;
  totalCost?: number;
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

export interface SessionAnalyticsResponse extends SourceDiagnostics {
  summary: SessionAnalyticsSummary;
  llmCallTrend: SessionLlmCallTrendEntry[];
  /** Native Skill invocations or conservatively inferred process usage. */
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
