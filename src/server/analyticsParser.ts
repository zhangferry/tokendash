import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { scanOpenClawSessions } from './openclawParser.js';
import type { AnalyticsResponse, ToolUsageEntry, DailyCodeChange, DailyToolCall, ProductivityKPIs } from '../shared/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ToolCallRecord {
  toolName: string;       // normalized name
  timestamp: number;      // ms epoch
  filePath?: string;
  linesAdded: number;
  linesDeleted: number;
}

// ---------------------------------------------------------------------------
// Timezone helpers (same as other parsers)
// ---------------------------------------------------------------------------

const TZ_OFFSETS: Record<string, number> = {
  'Asia/Shanghai': 8,
  'Asia/Tokyo': 9,
  'America/New_York': -5,
  'America/Los_Angeles': -8,
  'Europe/London': 0,
  'UTC': 0,
};

function getDateKey(ms: number, tz: string): string {
  const offset = (TZ_OFFSETS[tz] ?? 8) * 3_600_000;
  const d = new Date(ms + offset);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Tool name normalization
// ---------------------------------------------------------------------------

export function normalizeToolName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.startsWith('mcp__')) {
    const parts = name.split('__');
    const serverPart = parts.length >= 3 ? parts[2] : 'mcp';
    return `MCP:${serverPart}`;
  }
  const mapping: Record<string, string> = {
    'exec': 'Bash',
    'read': 'Read',
    'edit': 'Edit',
    'write': 'Write',
  };
  return mapping[lower] || name;
}

// ---------------------------------------------------------------------------
// Line counting
// ---------------------------------------------------------------------------

function countLines(text: string): number {
  if (!text) return 0;
  return text.split('\n').length;
}

// ---------------------------------------------------------------------------
// Claude Code session scanning & tool extraction
// ---------------------------------------------------------------------------

const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');

function extractProjectName(dirName: string): string {
  const parts = dirName.replace(/^-/, '').split('-');
  return parts[parts.length - 1] || dirName;
}

function matchesProject(dirName: string, filter: string): boolean {
  return extractProjectName(dirName) === extractProjectName(filter);
}

// Session-level cache (mtime-based)
const claudeSessionCache = new Map<string, { mtime: number; toolCalls: ToolCallRecord[] }>();

export function extractClaudeToolCalls(project?: string | null): ToolCallRecord[] {
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return [];

  const results: ToolCallRecord[] = [];
  const projectDirs = readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  for (const dirName of projectDirs) {
    if (project && !matchesProject(dirName, project)) continue;

    const dirPath = join(CLAUDE_PROJECTS_DIR, dirName);
    let files: string[];
    try {
      files = readdirSync(dirPath).filter(f => f.endsWith('.jsonl'));
    } catch {
      continue;
    }

    for (const file of files) {
      const filePath = join(dirPath, file);

      let mtime = 0;
      try { mtime = statSync(filePath).mtimeMs; } catch { /* ok */ }

      const cached = claudeSessionCache.get(filePath);
      if (cached && cached.mtime === mtime) {
        results.push(...cached.toolCalls);
        continue;
      }

      const toolCalls: ToolCallRecord[] = [];
      let content: string;
      try {
        content = readFileSync(filePath, 'utf-8');
      } catch {
        continue;
      }

      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let obj: Record<string, unknown>;
        try { obj = JSON.parse(trimmed) as Record<string, unknown>; } catch { continue; }

        if (obj.type !== 'assistant' || !obj.message) continue;
        const msg = obj.message as Record<string, unknown>;
        const timestamp = new Date(obj.timestamp as string).getTime();
        const content_arr = msg.content as Array<Record<string, unknown>> | undefined;
        if (!content_arr) continue;

        for (const item of content_arr) {
          if (item.type !== 'tool_use') continue;

          const toolName = normalizeToolName(item.name as string);
          const input = (item.input as Record<string, unknown>) || {};

          let linesAdded = 0;
          let linesDeleted = 0;
          const filePath2 = (input.file_path as string) || undefined;

          if (toolName === 'Edit') {
            linesDeleted = countLines(input.old_string as string || '');
            linesAdded = countLines(input.new_string as string || '');
          } else if (toolName === 'Write') {
            linesAdded = countLines(input.content as string || '');
          }

          toolCalls.push({ toolName, timestamp, filePath: filePath2, linesAdded, linesDeleted });
        }
      }

      claudeSessionCache.set(filePath, { mtime, toolCalls });
      results.push(...toolCalls);
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// OpenClaw tool extraction
// ---------------------------------------------------------------------------

const openclawSessionCache = new Map<string, { mtime: number; toolCalls: ToolCallRecord[] }>();

export function extractOpenClawToolCalls(project?: string | null): ToolCallRecord[] {
  const results: ToolCallRecord[] = [];
  const refs = scanOpenClawSessions();

  for (const ref of refs) {
    if (project && ref.agentId !== project) continue;

    let mtime = 0;
    try { mtime = statSync(ref.sessionFile).mtimeMs; } catch { /* ok */ }

    const cached = openclawSessionCache.get(ref.sessionFile);
    if (cached && cached.mtime === mtime) {
      results.push(...cached.toolCalls);
      continue;
    }

    const toolCalls: ToolCallRecord[] = [];
    let content: string;
    try {
      content = readFileSync(ref.sessionFile, 'utf-8');
    } catch {
      continue;
    }

    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let obj: Record<string, unknown>;
      try { obj = JSON.parse(trimmed) as Record<string, unknown>; } catch { continue; }

      if (obj.type !== 'message') continue;
      const msg = obj.message as Record<string, unknown>;
      if (msg.role !== 'assistant') continue;

      const timestamp = Number(msg.timestamp ?? 0);
      const content_arr = msg.content as Array<Record<string, unknown>> | undefined;
      if (!content_arr) continue;

      for (const item of content_arr) {
        if (item.type !== 'toolCall') continue;

        const toolName = normalizeToolName(item.name as string);
        const args = (item.arguments as Record<string, unknown>) || {};

        let linesAdded = 0;
        let linesDeleted = 0;
        const filePath2 = (args.path as string) || undefined;

        if (toolName === 'Edit') {
          linesDeleted = countLines(args.oldText as string || '');
          linesAdded = countLines(args.newText as string || '');
        } else if (toolName === 'Write') {
          linesAdded = countLines(args.content as string || '');
        }

        toolCalls.push({ toolName, timestamp, filePath: filePath2, linesAdded, linesDeleted });
      }
    }

    openclawSessionCache.set(ref.sessionFile, { mtime, toolCalls });
    results.push(...toolCalls);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Analytics computation
// ---------------------------------------------------------------------------

export function computeAnalytics(toolCalls: ToolCallRecord[], timezone = 'Asia/Shanghai'): AnalyticsResponse {
  // 1. Code Change Trend — group edit/write calls by date
  const changeMap = new Map<string, { added: number; deleted: number; files: Set<string> }>();
  for (const tc of toolCalls) {
    if (tc.linesAdded === 0 && tc.linesDeleted === 0) continue;
    const key = getDateKey(tc.timestamp, timezone);
    if (!changeMap.has(key)) changeMap.set(key, { added: 0, deleted: 0, files: new Set() });
    const entry = changeMap.get(key)!;
    entry.added += tc.linesAdded;
    entry.deleted += tc.linesDeleted;
    if (tc.filePath) entry.files.add(tc.filePath);
  }
  const codeChangeTrend: DailyCodeChange[] = [];
  for (const [date, { added, deleted, files }] of changeMap) {
    codeChangeTrend.push({ date, linesAdded: added, linesDeleted: deleted, netChange: added - deleted, filesModified: files.size });
  }
  codeChangeTrend.sort((a, b) => a.date.localeCompare(b.date));

  // 2. Tool Usage Distribution — count per tool
  const toolCountMap = new Map<string, number>();
  for (const tc of toolCalls) {
    toolCountMap.set(tc.toolName, (toolCountMap.get(tc.toolName) || 0) + 1);
  }
  const toolUsageDistribution: ToolUsageEntry[] = [...toolCountMap.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  // 3. Productivity KPIs
  const editCalls = toolCalls.filter(tc => tc.toolName === 'Edit' || tc.toolName === 'Write');
  const totalEdits = editCalls.length;
  const totalLinesChanged = editCalls.reduce((s, tc) => s + tc.linesAdded + tc.linesDeleted, 0);
  const totalLinesAdded = editCalls.reduce((s, tc) => s + tc.linesAdded, 0);
  const totalLinesDeleted = editCalls.reduce((s, tc) => s + tc.linesDeleted, 0);
  const uniqueFiles = new Set(editCalls.filter(tc => tc.filePath).map(tc => tc.filePath!));
  const editDates = new Set(editCalls.map(tc => getDateKey(tc.timestamp, timezone)));

  const productivityKPIs: ProductivityKPIs = {
    avgLinesPerEdit: totalEdits > 0 ? Math.round(totalLinesChanged / totalEdits) : 0,
    filesModifiedPerDay: editDates.size > 0 ? Math.round(uniqueFiles.size / editDates.size) : 0,
    addDeleteRatio: totalLinesDeleted > 0 ? Math.round((totalLinesAdded / totalLinesDeleted) * 100) / 100 : totalLinesAdded > 0 ? 1 : 0,
    totalEdits,
    totalFilesModified: uniqueFiles.size,
    activeDaysWithEdits: editDates.size,
  };

  // 4. Tool Call Trend — group all calls by (date, toolName)
  const trendMap = new Map<string, Map<string, number>>();
  for (const tc of toolCalls) {
    const date = getDateKey(tc.timestamp, timezone);
    if (!trendMap.has(date)) trendMap.set(date, new Map());
    const dayMap = trendMap.get(date)!;
    dayMap.set(tc.toolName, (dayMap.get(tc.toolName) || 0) + 1);
  }
  const toolCallTrend: DailyToolCall[] = [];
  for (const [date, dayMap] of trendMap) {
    const entry: DailyToolCall = { date };
    for (const [tool, count] of dayMap) {
      entry[tool] = count;
    }
    toolCallTrend.push(entry);
  }
  toolCallTrend.sort((a, b) => a.date.localeCompare(b.date));

  return { codeChangeTrend, toolUsageDistribution, productivityKPIs, toolCallTrend };
}
