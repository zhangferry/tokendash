import { accessSync, constants, existsSync, readdirSync, realpathSync } from 'node:fs';
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

/** Return readable Codex transcript directories nested under managed session homes. */
function discoverManagedCodexSessionDirs(root: string): string[] {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const result: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const codexHome = join(root, entry.name, 'agent-plugin-homes', 'codex');
    for (const leaf of ['sessions', 'archived_sessions']) {
      const transcriptDir = join(codexHome, leaf);
      try {
        accessSync(transcriptDir, constants.R_OK);
        result.push(transcriptDir);
      } catch {
        // A managed session may not have started Codex or created archives yet.
      }
    }
  }
  return uniquePaths(result);
}

/** Expand a configured home or transcript folder into concrete JSONL roots. */
export function codexSessionDirsForDataPath(path: string): string[] {
  const leaf = basename(path);
  const conventionalDirs = leaf === 'sessions' || leaf === 'archived_sessions'
    ? [path]
    : [join(path, 'sessions'), join(path, 'archived_sessions')];
  const managedDirs = conventionalDirs.flatMap(discoverManagedCodexSessionDirs);
  return managedDirs.length > 0 ? uniquePaths(managedDirs) : conventionalDirs;
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
