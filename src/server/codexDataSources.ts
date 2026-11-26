import { accessSync, closeSync, constants, existsSync, openSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs';
import { basename, delimiter, join } from 'node:path';
import { homedir } from 'node:os';
import { normalizeLocalDataPath, readAppSettings } from './appSettings.js';

export type CodexDataPathKind = 'official' | 'environment' | 'custom';

export interface CodexDataPathStatus {
  path: string;
  kind: CodexDataPathKind;
  readable: boolean;
  sessionDirs: string[];
}

/** Split a path-list environment value into individual local data path candidates. */
function parsePathList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(delimiter)
    .flatMap(part => part.split(','))
    .map(part => normalizeLocalDataPath(part))
    .filter((part): part is string => part !== null);
}

/** Return the canonical de-duplication key for a path, preserving missing paths. */
function canonicalPathKey(path: string): string {
  try {
    return existsSync(path) ? realpathSync(path) : path;
  } catch {
    return path;
  }
}

/** De-duplicate filesystem paths while preserving the caller's ordering. */
function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    const key = canonicalPathKey(path);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(path);
  }
  return result;
}

/** Return the official Codex home directories TokenDash scans by default. */
export function getOfficialCodexDataPaths(): string[] {
  const codexHome = parsePathList(process.env.CODEX_HOME);
  return codexHome.length > 0 ? uniquePaths(codexHome) : [join(homedir(), '.codex')];
}

/** Return additional Codex-compatible data paths provided through env vars. */
export function getEnvironmentCodexDataPaths(): string[] {
  return uniquePaths([
    ...parsePathList(process.env.TOKENDASH_CODEX_HOME),
    ...parsePathList(process.env.TOKENDASH_CODEX_HOMES),
  ]);
}

/** Return custom Codex-compatible data paths persisted from the settings UI. */
export function getCustomCodexDataPaths(): string[] {
  return readAppSettings().codex.customDataPaths;
}

const CODEX_TRANSCRIPT_LEAVES = new Set(['sessions', 'archived_sessions']);
/** Codex partitions `sessions/` as YYYY/MM/DD; `archived_sessions/` is flat. */
const ROLLOUT_PARTITION_PATTERNS = [/^\d{4}$/, /^\d{2}$/, /^\d{2}$/];
/** Upper bound for descending through a session manager's container layout. */
const NESTED_TRANSCRIPT_MAX_DEPTH = 6;
/** A Codex `session_meta` record is ~20KB; only its head is needed to recognise it. */
const ROLLOUT_PROBE_BYTES = 64 * 1024;
const MAX_ROLLOUT_PROBES_PER_DIR = 16;
const MAX_LISTED_DIRS = 4000;

interface DirEntrySummary {
  path: string;
  directory: boolean;
}

/** Per-resolution view of the filesystem so every directory and file head is read once. */
interface FsLookup {
  list(dir: string): DirEntrySummary[] | null;
  isRollout(file: string): boolean;
}

function createLookup(): FsLookup {
  const listings = new Map<string, DirEntrySummary[] | null>();
  const rollouts = new Map<string, boolean>();
  let listedDirs = 0;

  const list = (dir: string): DirEntrySummary[] | null => {
    const cached = listings.get(dir);
    if (cached !== undefined) return cached;
    let entries: DirEntrySummary[] | null = null;
    if (listedDirs < MAX_LISTED_DIRS) {
      listedDirs += 1;
      try {
        entries = readdirSync(dir, { withFileTypes: true })
          .filter(entry => !entry.name.startsWith('.'))
          .map(entry => {
            const path = join(dir, entry.name);
            let directory = entry.isDirectory();
            if (!directory && entry.isSymbolicLink()) {
              try {
                directory = statSync(path).isDirectory();
              } catch {
                // A dangling link is not a directory to descend into.
              }
            }
            return { path, directory };
          });
      } catch {
        entries = null;
      }
    }
    listings.set(dir, entries);
    return entries;
  };

  const isRollout = (file: string): boolean => {
    const cached = rollouts.get(file);
    if (cached !== undefined) return cached;
    let result = false;
    try {
      result = startsWithSessionMeta(file);
    } catch {
      result = false;
    }
    rollouts.set(file, result);
    return result;
  };

  return { list, isRollout };
}

/** Check whether a JSONL file opens with the `session_meta` record Codex writes first. */
function startsWithSessionMeta(file: string): boolean {
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(ROLLOUT_PROBE_BYTES);
    const bytesRead = readSync(fd, buffer, 0, ROLLOUT_PROBE_BYTES, 0);
    const head = buffer.toString('utf8', 0, bytesRead);
    const lineEnd = head.indexOf('\n');
    if (lineEnd !== -1) {
      const record = JSON.parse(head.slice(0, lineEnd)) as Record<string, unknown>;
      return record.type === 'session_meta';
    }
    // The first record is longer than the probe window; its top-level type is near the start.
    return /^\s*\{/.test(head) && /"type"\s*:\s*"session_meta"/.test(head.slice(0, 256));
  } finally {
    closeSync(fd);
  }
}

function subDirectories(dir: string, lookup: FsLookup): DirEntrySummary[] {
  return (lookup.list(dir) ?? []).filter(entry => entry.directory);
}

function hasRolloutFile(dir: string, lookup: FsLookup): boolean {
  const entries = lookup.list(dir);
  if (!entries) return false;
  let probes = 0;
  for (const entry of entries) {
    if (entry.directory || !entry.path.endsWith('.jsonl')) continue;
    if (probes >= MAX_ROLLOUT_PROBES_PER_DIR) break;
    probes += 1;
    if (lookup.isRollout(entry.path)) return true;
  }
  return false;
}

/**
 * Check whether a directory is a Codex transcript root: it holds rollout files
 * directly (archived_sessions) or under Codex's YYYY/MM/DD partitions (sessions).
 * The check is content based, so a container that merely happens to be named
 * `sessions` is not mistaken for one.
 */
function isCodexTranscriptRoot(dir: string, lookup: FsLookup): boolean {
  if (hasRolloutFile(dir, lookup)) return true;
  let partitions = subDirectories(dir, lookup);
  for (let depth = 0; depth < ROLLOUT_PARTITION_PATTERNS.length; depth += 1) {
    partitions = partitions.filter(partition => ROLLOUT_PARTITION_PATTERNS[depth].test(basename(partition.path)));
    if (depth < ROLLOUT_PARTITION_PATTERNS.length - 1) {
      partitions = partitions.flatMap(partition => subDirectories(partition.path, lookup));
    }
  }
  return partitions.some(partition => hasRolloutFile(partition.path, lookup));
}

/**
 * Find Codex transcript roots nested under a session manager's container without
 * assuming its layout: descend breadth-first, treat the first directory that
 * verifiably holds Codex rollouts as a transcript root, and stop there.
 */
function discoverNestedCodexTranscriptRoots(root: string, lookup: FsLookup): string[] {
  const roots: string[] = [];
  let frontier = [root];
  for (let depth = 0; frontier.length > 0 && depth <= NESTED_TRANSCRIPT_MAX_DEPTH; depth += 1) {
    const next: string[] = [];
    for (const dir of frontier) {
      if (isCodexTranscriptRoot(dir, lookup)) {
        roots.push(dir);
        continue;
      }
      for (const entry of subDirectories(dir, lookup)) next.push(entry.path);
    }
    frontier = next;
  }
  return uniquePaths(roots);
}

/** Resolve one candidate directory: itself when it is a transcript root, else what it contains. */
function resolveTranscriptDir(dir: string, lookup: FsLookup): string[] {
  if (isCodexTranscriptRoot(dir, lookup)) return [dir];
  if (lookup.list(dir) === null) return [dir];
  const nested = discoverNestedCodexTranscriptRoots(dir, lookup);
  return nested.length > 0 ? nested : [dir];
}

/**
 * Expand a configured path into concrete Codex transcript roots. A Codex home
 * resolves to its `sessions` and `archived_sessions`; a managed session root or
 * a single managed session resolves to the Codex transcript roots nested inside it.
 */
export function codexSessionDirsForDataPath(path: string): string[] {
  const conventionalDirs = CODEX_TRANSCRIPT_LEAVES.has(basename(path))
    ? [path]
    : [join(path, 'sessions'), join(path, 'archived_sessions')];
  const lookup = createLookup();
  const resolved = conventionalDirs.flatMap(dir => resolveTranscriptDir(dir, lookup));

  const hasCodexLayout = conventionalDirs.some(dir => lookup.list(dir) !== null);
  if (!CODEX_TRANSCRIPT_LEAVES.has(basename(path)) && !hasCodexLayout) {
    const nested = discoverNestedCodexTranscriptRoots(path, lookup);
    if (nested.length > 0) return uniquePaths(nested);
  }
  return uniquePaths(resolved);
}

/** Check whether at least one resolved transcript folder is readable. */
function isDataPathReadable(sessionDirs: string[]): boolean {
  return sessionDirs.some(dir => {
    try {
      accessSync(dir, constants.R_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/** Return every configured Codex-compatible data path with readability status. */
export function getCodexDataPathStatuses(): CodexDataPathStatus[] {
  const entries: Array<{ path: string; kind: CodexDataPathKind }> = [
    ...getOfficialCodexDataPaths().map(path => ({ path, kind: 'official' as const })),
    ...getEnvironmentCodexDataPaths().map(path => ({ path, kind: 'environment' as const })),
    ...getCustomCodexDataPaths().map(path => ({ path, kind: 'custom' as const })),
  ];

  const seen = new Set<string>();
  const statuses: CodexDataPathStatus[] = [];
  for (const entry of entries) {
    const key = canonicalPathKey(entry.path);
    if (seen.has(key)) continue;
    seen.add(key);
    const sessionDirs = codexSessionDirsForDataPath(entry.path);
    statuses.push({
      ...entry,
      readable: isDataPathReadable(sessionDirs),
      sessionDirs,
    });
  }
  return statuses;
}

/** Resolve every Codex-compatible data path that should contribute to usage. */
export function getCodexHomes(): string[] {
  return getCodexDataPathStatuses().map(status => status.path);
}

/** Return every live/archived transcript directory for all configured paths. */
export function getCodexSessionDirs(): string[] {
  return uniquePaths(getCodexDataPathStatuses().flatMap(status => status.sessionDirs));
}

/** Check whether at least one configured Codex transcript directory is readable. */
export function isCodexSessionDirAccessible(): boolean {
  return getCodexDataPathStatuses().some(status => status.readable);
}
