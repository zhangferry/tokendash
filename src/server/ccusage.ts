import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, constants } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { isSessionsDirAccessible } from './codexParser.js';

const execFileAsync = promisify(execFile);

interface CommandSpec {
  command: string;
  args: string[];
}

function withJsonFlag(args: string[], asJson: boolean): string[] {
  if (!asJson || args.includes('--json')) {
    return args;
  }

  return [...args, '--json'];
}

async function runCommand(spec: CommandSpec, timeout: number): Promise<string> {
  const { stdout } = await execFileAsync(spec.command, spec.args, {
    timeout,
    maxBuffer: 10 * 1024 * 1024,
  });

  return stdout;
}

function isMissingCommand(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'ENOENT';
}

async function runCcusageCommand(args: string[], timeout: number, asJson: boolean): Promise<string> {
  const primary: CommandSpec = {
    command: 'ccusage',
    args: withJsonFlag(args, asJson),
  };
  const fallback: CommandSpec = {
    command: 'npx',
    args: ['--yes', 'ccusage@latest', ...withJsonFlag(args, asJson)],
  };

  try {
    return await runCommand(primary, timeout);
  } catch (error) {
    if (isMissingCommand(error)) {
      return runCommand(fallback, timeout);
    }

    throw error;
  }
}

export async function runCcusage(args: string[], timeout = 30_000): Promise<string> {
  return runCcusageCommand(args, timeout, true);
}

export async function ensureUsageToolsReady(): Promise<void> {
  // Claude Code: check ccusage CLI
  await runCcusageCommand(['--version'], 120_000, false);

  // Codex: check local sessions directory (instant, no npm subprocess)
  if (!isSessionsDirAccessible()) {
    throw new Error('Codex sessions directory not found at ~/.codex/sessions/');
  }
}

export async function isClaudeCodeAvailable(): Promise<boolean> {
  try {
    await runCcusageCommand(['--version'], 120_000, false);
    return true;
  } catch {
    return false;
  }
}

export async function detectAvailableAgents(): Promise<{ claude: boolean; codex: boolean }> {
  const [claude, codex] = await Promise.all([
    isClaudeCodeAvailable(),
    Promise.resolve(isSessionsDirAccessible()),
  ]);
  return { claude, codex };
}
