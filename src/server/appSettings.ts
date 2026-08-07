import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

export interface AppSettings {
  codex: {
    customDataPaths: string[];
  };
}

const DEFAULT_SETTINGS: AppSettings = {
  codex: {
    customDataPaths: [],
  },
};

function settingsFilePath(): string {
  return process.env.TOKENDASH_SETTINGS_FILE || join(homedir(), '.tokendash', 'settings.json');
}

/** Expand and canonicalize a user-entered local data path. */
export function normalizeLocalDataPath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const expanded = trimmed === '~'
    ? homedir()
    : trimmed.startsWith('~/')
      ? join(homedir(), trimmed.slice(2))
      : trimmed;
  return resolve(expanded);
}

/** Normalize and de-duplicate persisted path lists while preserving user order. */
export function normalizeDataPathList(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const rawPath of paths) {
    const normalized = normalizeLocalDataPath(rawPath);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

/** Read TokenDash server settings from ~/.tokendash/settings.json. */
export function readAppSettings(): AppSettings {
  const path = settingsFilePath();
  try {
    if (!existsSync(path)) return DEFAULT_SETTINGS;
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<AppSettings>;
    return {
      codex: {
        customDataPaths: normalizeDataPathList(raw.codex?.customDataPaths ?? []),
      },
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/** Persist TokenDash server settings atomically enough for small local JSON files. */
export function writeAppSettings(settings: AppSettings): AppSettings {
  const normalized: AppSettings = {
    codex: {
      customDataPaths: normalizeDataPathList(settings.codex.customDataPaths),
    },
  };
  const path = settingsFilePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  return normalized;
}

/** Replace the custom Codex-compatible data paths stored in TokenDash settings. */
export function updateCodexCustomDataPaths(paths: string[]): AppSettings {
  return writeAppSettings({
    ...readAppSettings(),
    codex: {
      customDataPaths: paths,
    },
  });
}
