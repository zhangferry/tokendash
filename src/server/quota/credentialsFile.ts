import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Reads the cross-process credential bridge file written by the Swift app's
 * CredentialSheet (~/.tokendash/credentials.json). Adapters check this FIRST —
 * before env vars and settings.json — so a key entered in-app wins.
 *
 * Read fresh on each call (no cache) so a credential saved via the sheet takes
 * effect on the very next quota refresh. The file is tiny, so the cost is nil.
 */
export interface StoredCredential {
  apiKey: string;
  baseUrl?: string;
}

export function readStoredCredential(provider: string): StoredCredential | null {
  try {
    const path = join(homedir(), '.tokendash', 'credentials.json');
    if (!existsSync(path)) return null;
    const all = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const entry = all?.[provider];
    if (entry && typeof entry === 'object' && typeof (entry as { apiKey?: unknown }).apiKey === 'string') {
      const apiKey = (entry as { apiKey: string }).apiKey;
      if (!apiKey) return null;
      const baseUrl = (entry as { baseUrl?: unknown }).baseUrl;
      return { apiKey, baseUrl: typeof baseUrl === 'string' ? baseUrl : undefined };
    }
    return null;
  } catch {
    return null;
  }
}
