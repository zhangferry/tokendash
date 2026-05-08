import express from 'express';
import type { Express } from 'express';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { registerApiRoutes } from './routes/api.js';
import { detectAvailableAgents } from './agentDetection.js';
import open from 'open';

interface CliArgs {
  port?: number;
  noOpen?: boolean;
  showVersion?: boolean;
  tray?: boolean;
}

const CLI_USAGE = [
  'Usage:',
  '  tokendash',
  '  tokendash --version',
  '  tokendash --port <number> [--no-open]',
  '  tokendash --tray [--port <number>]',
].join('\n');

function getPackageVersion(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const packageJson = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as { version?: string };
  return packageJson.version ?? 'unknown';
}

function exitWithCliError(message: string): never {
  console.error(message);
  console.error(`\n${CLI_USAGE}`);
  process.exit(1);
}

function parseCliArgs(): CliArgs {
  const args = process.argv.slice(2);
  const result: CliArgs = {};

  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v')) {
    result.showVersion = true;
    return result;
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--version' || arg === '-v') {
      exitWithCliError('The --version flag must be used by itself.');
    }

    if (arg === '--port') {
      if (i + 1 >= args.length) {
        exitWithCliError('Missing value for --port.');
      }

      const value = parseInt(args[i + 1], 10);
      if (!Number.isInteger(value) || value <= 0) {
        exitWithCliError(`Invalid port value: ${args[i + 1]}`);
      }

      result.port = value;
      i++;
    } else if (arg === '--no-open') {
      result.noOpen = true;
    } else if (arg === '--tray') {
      result.tray = true;
    } else {
      exitWithCliError(`Unsupported argument: ${arg}`);
    }
  }

  return result;
}

async function ensureUsageSupportAvailable(): Promise<boolean> {
  try {
    const agents = detectAvailableAgents();
    if (!agents.claude && !agents.codex) {
      console.error('Error: No AI coding assistant data found.');
      console.error('\nDetails: Could not find Claude Code (~/.claude/projects/) or Codex (~/.codex/sessions/) data.');
      console.error('Please install at least one of: Claude Code or Codex CLI.');
      return false;
    }
    if (agents.claude) console.log('  ✓ Claude Code detected');
    if (agents.codex) console.log('  ✓ Codex detected');
    return true;
  } catch (error) {
    console.error('Error: failed to detect available AI coding assistants');
    console.error('\nDetails:', error instanceof Error ? error.message : error);
    return false;
  }
}

function resolvePort(value?: number): number {
  return Number.isInteger(value) && value && value > 0 ? value : 3456;
}

function listen(app: Express, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port);

    const handleListening = () => {
      cleanup();
      resolve(server);
    };

    const handleError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const cleanup = () => {
      server.off('listening', handleListening);
      server.off('error', handleError);
    };

    server.once('listening', handleListening);
    server.once('error', handleError);
  });
}

async function listenWithPortFallback(app: Express, preferredPort: number): Promise<{ server: Server; port: number; usedFallback: boolean }> {
  let port = preferredPort;

  for (let attempt = 0; attempt < 20; attempt++, port++) {
    try {
      const server = await listen(app, port);
      return { server, port, usedFallback: port !== preferredPort };
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'EADDRINUSE') {
        throw error;
      }
    }
  }

  throw new Error(`Could not find an available port starting from ${preferredPort}`);
}

export function createApp(_port: number, baseDir?: string): Express {
  const app = express();
  const router = express.Router();

  // Register API routes
  registerApiRoutes(router);
  app.use('/api', router);

  // Resolve paths: use provided baseDir or compute from import.meta.url
  const _baseDir = baseDir ?? dirname(fileURLToPath(import.meta.url));
  const isProduction = baseDir
    ? true
    : import.meta.url.includes('dist/');
  const popoverPath = isProduction
    ? join(_baseDir, 'client', 'popover.html')
    : join(_baseDir, '..', '..', 'public', 'popover.html');

  app.get('/popover.html', (_req, res) => {
    res.sendFile(popoverPath);
  });

  // Check if running from dist (production build)
  if (isProduction) {
    // Serve static files from client build
    const clientPath = join(_baseDir, 'client');
    const clientIndexPath = join(clientPath, 'index.html');

    app.use(express.static(clientPath));

    // SPA fallback
    app.use('{*path}', (_req, res) => {
      res.sendFile(clientIndexPath);
    });
  }

  return app;
}

async function main() {
  const args = parseCliArgs();
  if (args.showVersion) {
    console.log(getPackageVersion());
    return;
  }

  const version = getPackageVersion();
  const preferredPort = resolvePort(args.port ?? (process.env.PORT ? parseInt(process.env.PORT, 10) : undefined));

  // --tray mode: launch Electron
  if (args.tray) {
    if (process.platform !== 'darwin') {
      console.error('Error: --tray is only supported on macOS.');
      process.exit(1);
    }
    console.log(`Starting tokendash v${version} in tray mode...`);
    // @ts-ignore -- electron is installed separately for tray mode
    const { default: electronPath } = await import('electron');
    const { spawn } = await import('node:child_process');
    const child = spawn(electronPath as unknown as string, ['.'], {
      env: {
        ...process.env,
        TOKENDASH_PORT: String(preferredPort),
        TOKENDASH_TRAY: '1',
      },
      stdio: 'inherit',
    });
    child.on('close', (code) => process.exit(code ?? 0));
    process.on('SIGTERM', () => child.kill('SIGTERM'));
    return;
  }

  const shouldOpenBrowser = !args.noOpen;

  console.log(`Starting tokendash v${version}...`);
  console.log(`Checking local usage data sources...`);

  const isUsageSupportAvailable = await ensureUsageSupportAvailable();
  if (!isUsageSupportAvailable) {
    process.exit(1);
  }

  const app = createApp(preferredPort);
  const { server, port, usedFallback } = await listenWithPortFallback(app, preferredPort);

  if (usedFallback) {
    console.warn(`tokendash detected that port ${preferredPort} is already in use, switched to http://localhost:${port}`);
  }

  console.log(`tokendash running on http://localhost:${port}`);
  console.log(`API available at http://localhost:${port}/api`);
  const isProduction = import.meta.url.includes('dist/');
  if (isProduction) {
    console.log('Serving production build');
  } else {
    console.log('Development mode - use "npm run dev" for full dev experience');
  }

  // Open browser if requested
  if (shouldOpenBrowser) {
    // Small delay to ensure server is ready
    setTimeout(() => {
      console.log('Opening dashboard in your browser...');
      open(`http://localhost:${port}`).catch((err) => {
        console.warn('Could not open browser:', err.message);
      });
    }, 100);
  } else {
    console.log('Browser auto-open disabled (--no-open)');
  }

  // Graceful shutdown
  process.on('SIGTERM', () => {
    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });
  });
}

export { main };
