import type { AnalyticsResponse, DailyEntry, DailyResponse, ProjectsResponse, Totals } from '../../shared/types.js';
import { normalizePricingModel } from '../../shared/modelPricing.js';
import { projectName } from '../../shared/projectNames.js';
import { modelBreakdownTokens, modelTokenMode } from './modelAggregation.js';

export const AGENT_LABELS: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', openclaw: 'OpenClaw', opencode: 'OpenCode', pi: 'Pi', deepseek: 'DeepSeek Harness' };

export function mergeProjects(responses: ProjectsResponse[]): ProjectsResponse {
  const projects: Record<string, DailyEntry[]> = {};
  for (const response of responses) for (const [path, days] of Object.entries(response.projects)) {
    const name = projectName(path);
    projects[name] = mergeDailyResponses([{ daily: projects[name] ?? [] }, { daily: days }]).daily;
  }
  const sourceErrors = responses.flatMap(response => response.sourceErrors ?? []);
  return { projects, ...(sourceErrors.length ? { sourceErrors } : {}) };
}

export function mergeDailyResponses(responses: Pick<DailyResponse, 'daily' | 'sourceErrors'>[]): DailyResponse {
  const days = new Map<string, DailyEntry>();
  for (const response of responses) for (const entry of response.daily) {
    let day = days.get(entry.date);
    if (!day) {
      day = { date: entry.date, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0, totalCost: 0, estimatedTokens: 0, modelsUsed: [], modelBreakdowns: [] };
      days.set(entry.date, day);
    }
    for (const key of ['inputTokens', 'outputTokens', 'cacheCreationTokens', 'cacheReadTokens', 'totalTokens', 'totalCost', 'estimatedTokens'] as const) day[key] += entry[key] ?? 0;
    if (entry.costAvailable === false) day.costAvailable = false;
    day.modelsUsed = [...new Set([...day.modelsUsed, ...entry.modelsUsed.map(normalizePricingModel)])];
    for (const source of entry.modelBreakdowns) {
      const name = normalizePricingModel(source.modelName);
      const target = day.modelBreakdowns.find(model => model.modelName === name);
      const totalTokens = modelBreakdownTokens(source, modelTokenMode(entry));
      if (!target) day.modelBreakdowns.push({ ...source, modelName: name, totalTokens });
      else {
        if (source.costAvailable === false) target.costAvailable = false;
        target.totalTokens = (target.totalTokens ?? 0) + totalTokens;
        for (const key of ['inputTokens', 'outputTokens', 'cacheCreationTokens', 'cacheReadTokens', 'cost', 'estimatedTokens'] as const) target[key] += source[key] ?? 0;
      }
    }
  }
  const daily = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
  const totals: Totals = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0, totalCost: 0, estimatedTokens: 0 };
  for (const day of daily) {
    for (const key of ['inputTokens', 'outputTokens', 'cacheCreationTokens', 'cacheReadTokens', 'totalTokens', 'totalCost', 'estimatedTokens'] as const) totals[key] += day[key];
    if (day.costAvailable === false) totals.costAvailable = false;
  }
  const sourceErrors = responses.flatMap(response => response.sourceErrors ?? []);
  if (sourceErrors.length) totals.costAvailable = false;
  return { daily, totals, ...(sourceErrors.length ? { sourceErrors } : {}) };
}

export function mergeAnalytics(responses: AnalyticsResponse[]): AnalyticsResponse {
  const changes = new Map<string, AnalyticsResponse['codeChangeTrend'][number]>();
  const tools = new Map<string, number>();
  const calls = new Map<string, AnalyticsResponse['toolCallTrend'][number]>();
  let totalEdits = 0;
  let totalFilesModified = 0;
  for (const response of responses) {
    totalEdits += response.productivityKPIs.totalEdits;
    totalFilesModified += response.productivityKPIs.totalFilesModified;
    for (const source of response.codeChangeTrend) {
      const target = changes.get(source.date);
      if (!target) changes.set(source.date, { ...source });
      else for (const key of ['linesAdded', 'linesDeleted', 'netChange', 'filesModified'] as const) target[key] += source[key];
    }
    for (const tool of response.toolUsageDistribution) tools.set(tool.name, (tools.get(tool.name) ?? 0) + tool.count);
    for (const source of response.toolCallTrend) {
      const target = calls.get(source.date) ?? { date: source.date };
      for (const [key, value] of Object.entries(source)) if (key !== 'date' && typeof value === 'number') target[key] = Number(target[key] ?? 0) + value;
      calls.set(source.date, target);
    }
  }
  const codeChangeTrend = [...changes.values()].sort((a, b) => a.date.localeCompare(b.date));
  const added = codeChangeTrend.reduce((sum, day) => sum + day.linesAdded, 0);
  const deleted = codeChangeTrend.reduce((sum, day) => sum + day.linesDeleted, 0);
  const activeDaysWithEdits = codeChangeTrend.filter(day => day.linesAdded + day.linesDeleted > 0).length;
  return { ...(responses.some(response => response.sourceErrors?.length) ? { sourceErrors: responses.flatMap(response => response.sourceErrors ?? []) } : {}), codeChangeTrend, toolUsageDistribution: [...tools].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count), toolCallTrend: [...calls.values()].sort((a, b) => a.date.localeCompare(b.date)), productivityKPIs: { totalEdits, totalFilesModified, activeDaysWithEdits, avgLinesPerEdit: totalEdits ? (added + deleted) / totalEdits : 0, filesModifiedPerDay: activeDaysWithEdits ? totalFilesModified / activeDaysWithEdits : 0, addDeleteRatio: deleted ? added / deleted : 0 } };
}
