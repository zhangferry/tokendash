import { z } from 'zod';

export const ModelBreakdownSchema = z.object({
  modelName: z.string(),
  inputTokens: z.number().default(0),
  outputTokens: z.number().default(0),
  cacheCreationTokens: z.number().default(0),
  cacheReadTokens: z.number().default(0),
  cost: z.number().default(0),
});

export const DailyEntrySchema = z.object({
  date: z.string(),
  inputTokens: z.number().default(0),
  outputTokens: z.number().default(0),
  cacheCreationTokens: z.number().default(0),
  cacheReadTokens: z.number().default(0),
  totalTokens: z.number().default(0),
  totalCost: z.number().default(0),
  modelsUsed: z.array(z.string()).default([]),
  modelBreakdowns: z.array(ModelBreakdownSchema).default([]),
});

export const TotalsSchema = z.object({
  inputTokens: z.number().default(0),
  outputTokens: z.number().default(0),
  cacheCreationTokens: z.number().default(0),
  cacheReadTokens: z.number().default(0),
  totalTokens: z.number().default(0),
  totalCost: z.number().default(0),
});

export const DailyResponseSchema = z.object({
  daily: z.array(DailyEntrySchema).default([]),
  totals: TotalsSchema,
});

export const ProjectEntrySchema = z.object({
  projectPath: z.string(),
  instances: z.array(DailyEntrySchema).default([]),
});

export const ProjectsResponseSchema = z.object({
  projects: z.record(z.array(DailyEntrySchema).default([])).default({}),
});

export function validateDaily(data: unknown) {
  return DailyResponseSchema.parse(data);
}

export function validateProjects(data: unknown) {
  return ProjectsResponseSchema.parse(data);
}

const BlockEntrySchema = z.object({
  id: z.string(),
  startTime: z.string(),
  endTime: z.string(),
  actualEndTime: z.string().nullable().default(null),
  isActive: z.boolean().default(false),
  isGap: z.boolean().default(false),
  entries: z.number().default(0),
  tokenCounts: z.object({
    inputTokens: z.number().default(0),
    outputTokens: z.number().default(0),
    cacheCreationInputTokens: z.number().default(0),
    cacheReadInputTokens: z.number().default(0),
  }).default({ inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }),
  totalTokens: z.number().default(0),
  costUSD: z.number().default(0),
  models: z.array(z.string()).default([]),
});

export const BlocksResponseSchema = z.object({
  blocks: z.array(BlockEntrySchema).default([]),
});

export function validateBlocks(data: unknown) {
  return BlocksResponseSchema.parse(data);
}

// --- Analytics schemas ---

const DailyCodeChangeSchema = z.object({
  date: z.string(),
  linesAdded: z.number().default(0),
  linesDeleted: z.number().default(0),
  netChange: z.number().default(0),
  filesModified: z.number().default(0),
});

const ToolUsageEntrySchema = z.object({
  name: z.string(),
  count: z.number().default(0),
});

const ProductivityKPIsSchema = z.object({
  avgLinesPerEdit: z.number().default(0),
  filesModifiedPerDay: z.number().default(0),
  addDeleteRatio: z.number().default(0),
  totalEdits: z.number().default(0),
  totalFilesModified: z.number().default(0),
  activeDaysWithEdits: z.number().default(0),
});

const AnalyticsResponseSchema = z.object({
  codeChangeTrend: z.array(DailyCodeChangeSchema).default([]),
  toolUsageDistribution: z.array(ToolUsageEntrySchema).default([]),
  productivityKPIs: ProductivityKPIsSchema,
  toolCallTrend: z.array(z.record(z.union([z.string(), z.number()]))).default([]),
});

export function validateAnalytics(data: unknown) {
  return AnalyticsResponseSchema.parse(data);
}

// --- App settings schemas ---

const CodexDataPathStatusSchema = z.object({
  path: z.string(),
  kind: z.enum(['official', 'environment', 'custom']),
  readable: z.boolean().default(false),
  sessionDirs: z.array(z.string()).default([]),
});

const CodexSettingsResponseSchema = z.object({
  officialDataPaths: z.array(z.string()).default([]),
  environmentDataPaths: z.array(z.string()).default([]),
  customDataPaths: z.array(z.string()).default([]),
  resolvedDataPaths: z.array(CodexDataPathStatusSchema).default([]),
});

export const AppSettingsResponseSchema = z.object({
  codex: CodexSettingsResponseSchema,
});

export function validateAppSettings(data: unknown) {
  return AppSettingsResponseSchema.parse(data);
}

// --- Session analytics schemas ---

const SessionStatusSchema = z.enum(['active', 'complete', 'interrupted', 'unknown']);
const SessionEventTypeSchema = z.enum([
  'user_message',
  'llm_call',
  'skill_call',
  'tool_call',
  'tool_result',
  'assistant_message',
]);

const SessionUsageSchema = z.object({
  inputTokens: z.number().default(0),
  outputTokens: z.number().default(0),
  cacheReadTokens: z.number().default(0),
  totalTokens: z.number().default(0),
  cost: z.number().optional(),
});

export const SessionSummarySchema = z.object({
  id: z.string(),
  agent: z.string(),
  project: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  status: SessionStatusSchema,
  models: z.array(z.string()).default([]),
  llmCallCount: z.number().default(0),
  skillCallCount: z.number().optional(),
  toolCallCount: z.number().optional(),
  userTurnCount: z.number().optional(),
  durationMs: z.number().optional(),
  totalTokens: z.number().default(0),
  totalCost: z.number().default(0),
});

export const SessionEventSchema = z.object({
  id: z.string(),
  callId: z.string().optional(),
  timestamp: z.string(),
  type: SessionEventTypeSchema,
  model: z.string().optional(),
  skillName: z.string().optional(),
  toolName: z.string().optional(),
  success: z.boolean().optional(),
  usage: SessionUsageSchema.optional(),
  summary: z.string().optional(),
  phase: z.enum(['commentary', 'final_answer']).optional(),
  parameterSummary: z.string().optional(),
  resultSummary: z.string().optional(),
  contentPreview: z.string().optional(),
  contentAvailable: z.boolean().default(false),
  content: z.string().optional(),
});

export const SessionDetailSchema = z.object({
  session: SessionSummarySchema,
  events: z.array(SessionEventSchema).default([]),
  indexedAt: z.string(),
  capabilities: z.object({
    userTurns: z.boolean(),
    skills: z.boolean(),
    tools: z.boolean(),
    toolResults: z.boolean(),
    contentPreview: z.boolean(),
  }),
});

const SessionAnalyticsResponseSchema = z.object({
  summary: z.object({
    sessionCount: z.number().default(0),
    llmCallCount: z.number().default(0),
    skillCallCount: z.number().optional(),
    toolCallCount: z.number().optional(),
    avgDurationMs: z.number().optional(),
    medianDurationMs: z.number().optional(),
    avgUserTurnCount: z.number().optional(),
    longSessionRate: z.number().optional(),
    toolSuccessRate: z.number().optional(),
  }),
  llmCallTrend: z.array(z.object({
    date: z.string(),
    models: z.record(z.number()).default({}),
    total: z.number().optional(),
  })).default([]),
  skillDistribution: z.array(z.object({ name: z.string(), count: z.number().default(0) })).optional(),
  toolDistribution: z.array(z.object({ name: z.string(), count: z.number().default(0) })).optional(),
  durationTurnTrend: z.array(z.object({
    date: z.string(),
    avgDurationMs: z.number().optional(),
    medianDurationMs: z.number().optional(),
    avgUserTurnCount: z.number().optional(),
    avgDurationMinutes: z.number().optional(),
    avgUserTurns: z.number().optional(),
  })).default([]),
  userTurnDistribution: z.array(z.object({
    bucket: z.string(),
    sessionCount: z.number().default(0),
    percentage: z.number().default(0),
  })).default([]),
  longSessionThreshold: z.number().optional(),
  sessions: z.array(SessionSummarySchema).default([]),
  pagination: z.object({ nextCursor: z.string().optional(), totalCount: z.number().optional() }).default({}),
  capabilities: z.object({
    userTurns: z.boolean(),
    skills: z.boolean(),
    tools: z.boolean(),
    toolResults: z.boolean(),
    contentPreview: z.boolean(),
  }),
});

export function validateSessionAnalytics(data: unknown) {
  return SessionAnalyticsResponseSchema.parse(data);
}

export function validateSessionDetail(data: unknown) {
  return SessionDetailSchema.parse(data);
}
