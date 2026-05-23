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

const projectNameCache = new Map<string, string>();

/** Decode Claude's encoded project directory name.
 *  Claude encodes paths: /Users/foo/bar → -Users-foo-bar
 *  Since '-' replaces '/' and project names can contain '-',
 *  we use filesystem checks to find the correct last segment.
 */
function extractProjectName(dirName: string): string {
  if (!dirName.startsWith('-')) return dirName;

  const cached = projectNameCache.get(dirName);
  if (cached) return cached;

  const segments = dirName.replace(/^-/, '').split('-').filter(Boolean);
  if (segments.length === 0) { projectNameCache.set(dirName, dirName); return dirName; }
  if (segments.length === 1) { projectNameCache.set(dirName, segments[0]); return segments[0]; }

  let bestName = segments[segments.length - 1];

  for (let splitAt = segments.length - 1; splitAt >= 1; splitAt--) {
    const parentSegments = segments.slice(0, splitAt);
    const candidateName = segments.slice(splitAt).join('-');

    let parentPath = '/';
    let valid = true;
    for (const seg of parentSegments) {
      const regular = join(parentPath, seg);
      const hidden = join(parentPath, '.' + seg);
      if (existsSync(regular)) {
        parentPath = regular;
      } else if (existsSync(hidden)) {
        parentPath = hidden;
      } else {
        valid = false;
        break;
      }
    }

    if (!valid) continue;

    if (existsSync(join(parentPath, candidateName)) || existsSync(join(parentPath, '.' + candidateName))) {
      bestName = candidateName;
      break;
    }
  }

  projectNameCache.set(dirName, bestName);
  return bestName;
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
        const totalTokens = inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens;

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
    const totalTokens = bucket.inputTokens + bucket.outputTokens + bucket.cacheCreationTokens + bucket.cacheReadTokens;
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
