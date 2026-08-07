import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { isCodexSessionDirAccessible } from './codexDataSources.js';
import { isOpenClawAccessible } from './openclawParser.js';
import { isOpencodeAccessible } from './opencodeParser.js';
import { isPiAccessible } from './piParser.js';

const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');

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
  return isCodexSessionDirAccessible();
}

export function isOpencodeAvailable(): boolean {
  return isOpencodeAccessible();
}

export interface AvailableAgents {
  claude: boolean;
  codex: boolean;
  openclaw: boolean;
  opencode: boolean;
  pi: boolean;
}

export function detectAvailableAgents(): AvailableAgents {
  return {
    claude: isClaudeCodeAvailable(),
    codex: isCodexAvailable(),
    openclaw: isOpenClawAccessible(),
    opencode: isOpencodeAvailable(),
    pi: isPiAccessible(),
  };
}
