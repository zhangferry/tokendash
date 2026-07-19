/**
 * Validation script: compare custom JSONL parser output against ccusage.
 * Run with: npx tsx scripts/validate-codex-parser.ts
 *
 * Re-run this script whenever Codex is updated to catch format drift.
 */

import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { getDailyResponse } from '../src/server/codexParser.js';

const execFileAsync = promisify(execFile);

interface CcusageModelEntry {
  inputTokens: number;
  cachedInputTokens?: number;
  cacheReadTokens?: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  isFallback: boolean;
}

interface CcusageDailyEntry {
  date: string;
  inputTokens: number;
  cachedInputTokens?: number;
  cacheReadTokens?: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  costUSD: number;
  models: Record<string, CcusageModelEntry>;
}

interface CcusageResponse {
  daily: CcusageDailyEntry[];
  totals: {
    inputTokens: number;
    cachedInputTokens?: number;
    cacheReadTokens?: number;
    outputTokens: number;
    reasoningOutputTokens: number;
    totalTokens: number;
    costUSD: number;
  };
}

const MONTH_MAP: Record<string, string> = {
  'Jan': '01', 'Feb': '02', 'Mar': '03', 'Apr': '04',
  'May': '05', 'Jun': '06', 'Jul': '07', 'Aug': '08',
  'Sep': '09', 'Oct': '10', 'Nov': '11', 'Dec': '12',
};

function parseCodexDate(dateStr: string): string {
  // "Mar 31, 2026" → "2026-03-31" (direct parsing, no timezone shift)
  const match = dateStr.match(/^(\w{3})\s+(\d{1,2}),?\s+(\d{4})$/);
  if (!match) return dateStr;
  const [, month, day, year] = match;
  const mm = MONTH_MAP[month] ?? '01';
  const dd = day.padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

async function getCcusageData(): Promise<CcusageResponse> {
  const { stdout } = await execFileAsync('npx', ['--yes', 'ccusage@latest', 'codex', 'daily', '--json'], {
    timeout: 60_000,
    maxBuffer: 10 * 1024 * 1024,
    env: {
      ...process.env,
      // Compare the same active sessions directory as TokenDash. ccusage also
      // supports archived_sessions, which is intentionally outside this check.
      CODEX_HOME: join(homedir(), '.codex', 'sessions'),
    },
  });
  return JSON.parse(stdout) as CcusageResponse;
}

function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

function compare(label: string, ours: number, theirs: number, tolerance = 0): boolean {
  const diff = Math.abs(ours - theirs);
  const pass = diff <= tolerance;
  const status = pass ? 'PASS' : 'FAIL';
  console.log(`  ${status} ${label}: ours=${formatNumber(ours)}, ccusage=${formatNumber(theirs)}, diff=${formatNumber(diff)}`);
  return pass;
}

async function main(): Promise<void> {
  console.log('=== Codex Parser Validation ===\n');

  // Get data from both sources
  console.log('Fetching ccusage data...');
  const ccusage = await getCcusageData();

  console.log('Fetching custom parser data...');
  const ours = getDailyResponse();

  let allPass = true;

  // Compare totals
  console.log('\n--- Totals Comparison ---');
  allPass = compare('Total tokens', ours.totals.totalTokens, ccusage.totals.totalTokens) && allPass;
  allPass = compare('Input tokens', ours.totals.inputTokens, ccusage.totals.inputTokens) && allPass;
  allPass = compare('Cached input tokens', ours.totals.cacheReadTokens, ccusage.totals.cachedInputTokens ?? ccusage.totals.cacheReadTokens ?? 0) && allPass;
  allPass = compare('Output tokens', ours.totals.outputTokens, ccusage.totals.outputTokens) && allPass;
  allPass = compare('Cost (USD)', ours.totals.totalCost, ccusage.totals.costUSD, 0.01) && allPass;

  // Compare daily breakdown
  console.log('\n--- Daily Comparison ---');
  const ccusageByDate = new Map<string, CcusageDailyEntry>();
  for (const entry of ccusage.daily) {
    ccusageByDate.set(parseCodexDate(entry.date), entry);
  }

  for (const ourEntry of ours.daily) {
    const theirs = ccusageByDate.get(ourEntry.date);
    if (!theirs) {
      console.log(`  FAIL Date ${ourEntry.date}: not found in ccusage output`);
      allPass = false;
      continue;
    }

    console.log(`\n  Date: ${ourEntry.date}`);
    allPass = compare('    Total tokens', ourEntry.totalTokens, theirs.totalTokens) && allPass;
    allPass = compare('    Input tokens', ourEntry.inputTokens, theirs.inputTokens) && allPass;
    allPass = compare('    Output tokens', ourEntry.outputTokens, theirs.outputTokens) && allPass;
    allPass = compare('    Cached input tokens', ourEntry.cacheReadTokens, theirs.cachedInputTokens ?? theirs.cacheReadTokens ?? 0) && allPass;
    allPass = compare('    Cost (USD)', ourEntry.totalCost, theirs.costUSD, 0.01) && allPass;
  }

  // Check for missing dates
  for (const [date] of ccusageByDate) {
    const found = ours.daily.find(d => d.date === date);
    if (!found) {
      console.log(`  FAIL Date ${date}: present in ccusage but missing from custom parser`);
      allPass = false;
    }
  }

  console.log('\n=== Result ===');
  if (allPass) {
    console.log('ALL CHECKS PASSED');
    process.exit(0);
  } else {
    console.log('SOME CHECKS FAILED');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Validation failed:', err);
  process.exit(1);
});
