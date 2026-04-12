import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import type { BlockEntry } from '../shared/types.js';

// ---------------------------------------------------------------------------
// Zod schemas for Claude JSONL usage validation
// ---------------------------------------------------------------------------

const ClaudeUsageSchema = z.object({
  input_tokens: z.number().default(0),
  output_tokens: z.number().default(0),
  cache_creation_input_tokens: z.number().default(0),
  cache_read_input_tokens: z.number().default(0),
}).passthrough().default({});

const ClaudeMessageSchema = z.object({
  usage: ClaudeUsageSchema,
  model: z.string().optional(),
}).passthrough();

const ClaudeEventSchema = z.object({
  type: z.string(),
  timestamp: z.string(),
  message: ClaudeMessageSchema.optional(),
}).passthrough();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');

/** Extract project display name from encoded directory path.
 *  -Users-zhangferry-AI-Ideas → Ideas
 *  -Users-zhangferry-Desktop-Develop-DailyNewsReport → DailyNewsReport
 */
function extractProjectName(dirName: string): string {
  const parts = dirName.replace(/^-/, '').split('-');
  return parts[parts.length - 1] || dirName;
}

/** Match project display name against a filter (also normalizes the filter) */
function matchesProject(dirName: string, filter: string): boolean {
  return extractProjectName(dirName) === extractProjectName(filter);
}

// ---------------------------------------------------------------------------
// Core parser
// ---------------------------------------------------------------------------

interface HourBucket {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  models: Set<string>;
}

function getHourKey(timestamp: string): string {
  const d = new Date(timestamp);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${hh}`;
}

/**
 * Parse Claude Code JSONL files and return hourly blocks, optionally filtered by project.
 * Only returns blocks for the specified project (or all if project is empty).
 */
export function getClaudeBlocksByProject(project: string): BlockEntry[] {
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return [];

  const hourMap = new Map<string, HourBucket>();

  const projectDirs = readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  for (const dirName of projectDirs) {
    // If a project filter is set, skip non-matching directories
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
      let content: string;
      try {
        content = readFileSync(filePath, 'utf-8');
      } catch {
        continue;
      }

      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          continue;
        }

        // Only process assistant events with usage data
        const result = ClaudeEventSchema.safeParse(parsed);
        if (!result.success) continue;
        const event = result.data;

        if (event.type !== 'assistant' || !event.message) continue;

        const usage = event.message.usage;
        const inputTokens = usage.input_tokens;
        const outputTokens = usage.output_tokens;
        const cacheCreationTokens = usage.cache_creation_input_tokens;
        const cacheReadTokens = usage.cache_read_input_tokens;
        const totalTokens = inputTokens + outputTokens + cacheReadTokens;

        if (totalTokens === 0) continue;

        const hourKey = getHourKey(event.timestamp);
        if (!hourMap.has(hourKey)) {
          hourMap.set(hourKey, {
            inputTokens: 0, outputTokens: 0,
            cacheCreationTokens: 0, cacheReadTokens: 0,
            models: new Set(),
          });
        }

        const bucket = hourMap.get(hourKey)!;
        bucket.inputTokens += inputTokens;
        bucket.outputTokens += outputTokens;
        bucket.cacheCreationTokens += cacheCreationTokens;
        bucket.cacheReadTokens += cacheReadTokens;
        if (event.message.model) bucket.models.add(event.message.model);
      }
    }
  }

  // Convert hour map to BlockEntry[]
  const blocks: BlockEntry[] = [];
  let idx = 0;
  for (const [hourKey, bucket] of hourMap) {
    const totalTokens = bucket.inputTokens + bucket.outputTokens + bucket.cacheReadTokens;
    blocks.push({
      id: `claude-project-${idx}`,
      startTime: `${hourKey}:00:00.000Z`,
      endTime: `${hourKey}:59:59.999Z`,
      actualEndTime: null,
      isActive: false,
      isGap: false,
      entries: totalTokens > 0 ? 1 : 0,
      tokenCounts: {
        inputTokens: bucket.inputTokens,
        outputTokens: bucket.outputTokens,
        cacheCreationInputTokens: bucket.cacheCreationTokens,
        cacheReadInputTokens: bucket.cacheReadTokens,
      },
      totalTokens,
      costUSD: 0,
      models: [...bucket.models],
    });
    idx++;
  }

  blocks.sort((a, b) => a.startTime.localeCompare(b.startTime));
  return blocks;
}
