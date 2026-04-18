import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');
const CODEX_SESSIONS_DIR = join(homedir(), '.codex', 'sessions');

export function isClaudeCodeAvailable(): boolean {
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return false;
  try {
    const dirs = readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true });
    return dirs.some(d => d.isDirectory());
  } catch {
    return false;
  }
}

export function isCodexAvailable(): boolean {
  return existsSync(CODEX_SESSIONS_DIR);
}

export function detectAvailableAgents(): { claude: boolean; codex: boolean } {
  return {
    claude: isClaudeCodeAvailable(),
    codex: isCodexAvailable(),
  };
}
