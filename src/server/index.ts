import express from 'express';
import type { Express } from 'express';
import { existsSync, readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { basename, dirname, join, resolve } from 'node:path';
import { registerApiRoutes } from './routes/api.js';
import { detectAvailableAgents, type AvailableAgents } from './agentDetection.js';

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

const PACKAGE_NAME = '@zhangferry-dev/tokendash';

function getPackageVersion(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const packageJsonPaths = [
    join(__dirname, '..', '..', 'package.json'), // dist/server/index.js
    join(__dirname, '..', 'package.json'), // bundled server entrypoint
  ];

  for (const packageJsonPath of packageJsonPaths) {
    if (!existsSync(packageJsonPath)) continue;
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: string };
    if (packageJson.version) return packageJson.version;
  }

  return 'unknown';
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

export function hasUsageDataSource(agents: AvailableAgents): boolean {
  return Object.values(agents).some(Boolean);
}

async function ensureUsageSupportAvailable(): Promise<boolean> {
  try {
    const agents = detectAvailableAgents();
    if (!hasUsageDataSource(agents)) {
      console.error('Error: No AI coding assistant data found.');
      console.error('\nDetails: Could not find Claude Code, Codex, OpenClaw, OpenCode, or Pi usage data.');
      console.error('Please install at least one supported AI coding assistant.');
      return false;
    }
    if (agents.claude) console.log('  ✓ Claude Code detected');
    if (agents.codex) console.log('  ✓ Codex detected');
    if (agents.openclaw) console.log('  ✓ OpenClaw detected');
    if (agents.opencode) console.log('  ✓ OpenCode detected');
    if (agents.pi) console.log('  ✓ Pi detected');
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

async function listenWithPortFallback(app: Express, preferredPort: number, allowFallback: boolean): Promise<{ server: Server; port: number; usedFallback: boolean }> {
  // 开发模式下 Vite 代理固定指向首选端口，若静默回退到其他端口，
  // 前端请求会被代理到错误/残留进程导致页面永久加载；故 dev 下
  // 端口被占用直接报错，不做回退。生产模式无此约束，保留回退。
  if (!allowFallback) {
    try {
      const server = await listen(app, preferredPort);
      return { server, port: preferredPort, usedFallback: false };
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'EADDRINUSE') {
        throw new Error(
          `Port ${preferredPort} is already in use.\n` +
          'In development mode tokendash does not fall back to another port, because the Vite\n' +
          'dev proxy is fixed to this port; falling back would leave the dashboard loading forever.\n' +
          `Free port ${preferredPort} (kill the process using it) and retry.`,
        );
      }
      throw error;
    }
  }

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

export function resolveStaticAssetBaseDir(moduleUrl = import.meta.url, baseDir?: string): { baseDir: string; isProduction: boolean } {
  if (baseDir) return { baseDir: resolve(baseDir), isProduction: true };

  const moduleDir = dirname(fileURLToPath(moduleUrl));
  const isProduction = moduleUrl.includes('/dist/');

  if (!isProduction) return { baseDir: resolve(moduleDir), isProduction: false };

  // The CLI entrypoint runs from dist/server/index.js while the Vite assets are
  // emitted to dist/client. Resolve the production asset base to dist instead
  // of dist/server so / resolves to dist/client/index.html in installed npm
  // packages. The native app passes dist explicitly and is unaffected by this branch.
  if (basename(moduleDir) === 'server') {
    return { baseDir: resolve(dirname(moduleDir)), isProduction: true };
  }

  return { baseDir: resolve(moduleDir), isProduction: true };
}

export function createApp(_port: number, baseDir?: string): Express {
  const app = express();
  const router = express.Router();

  app.use(express.json({ limit: '16kb' }));

  // Register API routes
  registerApiRoutes(router, {
    packageName: PACKAGE_NAME,
    version: getPackageVersion(),
    dashboardUrl: `http://127.0.0.1:${resolvePort(_port)}`,
  });
  app.use('/api', router);

  const { baseDir: _baseDir, isProduction } = resolveStaticAssetBaseDir(import.meta.url, baseDir);
  const popoverPath = isProduction
    ? join(_baseDir, 'client', 'popover.html')
    : join(_baseDir, '..', '..', 'public', 'popover.html');

  app.get('/popover.html', (_req, res, next) => {
    if (!existsSync(popoverPath)) {
      next();
      return;
    }
    res.type('html').send(readFileSync(popoverPath, 'utf8'));
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

  // --tray mode: launch native Swift menu bar app
  if (args.tray) {
    if (process.platform !== 'darwin') {
      console.error('Error: --tray is only supported on macOS.');
      process.exit(1);
    }
    console.log(`Starting tokendash v${version} in tray mode...`);
    const { spawn } = await import('node:child_process');
    const { resolve } = await import('node:path');
    const { existsSync } = await import('node:fs');

    // Find Swift binary: check packaged app first, then dev build
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const packagedPath = resolve(moduleDir, '..', '..', 'TokenDashSwift', '.build', 'debug', 'TokenDash');
    const devPath = resolve(moduleDir, '..', '..', 'TokenDashSwift', '.build', 'debug', 'TokenDash');
    const swiftBin = existsSync(packagedPath) ? packagedPath : devPath;

    if (!existsSync(swiftBin)) {
      console.error('Error: TokenDash Swift binary not found. Run "npm run build:swift" first.');
      process.exit(1);
    }

    const child = spawn(swiftBin, [], {
      env: {
        ...process.env,
        TOKENDASH_PORT: String(preferredPort),
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

  const isProduction = import.meta.url.includes('dist/');
  const app = createApp(preferredPort);
  const { server, port, usedFallback } = await listenWithPortFallback(app, preferredPort, isProduction).catch((error) => {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });

  if (usedFallback) {
    console.warn(`tokendash detected that port ${preferredPort} is already in use, switched to http://127.0.0.1:${port}`);
  }

  console.log(`tokendash running on http://127.0.0.1:${port}`);
  console.log(`API available at http://127.0.0.1:${port}/api`);
  if (isProduction) {
    console.log('Serving production build');
  } else {
    console.log('Development mode - use "npm run dev" for full dev experience');
  }

  // Open browser if requested.
  // 开发模式下前端由 Vite 在 5173 端口提供，自动打开 API 端口（3456）并无意义；
  // 且在 concurrently（npm run dev）下 open 派生的子进程会继承被管道化的 stdio，
  // 造成管道死锁使服务进程挂起、页面一直加载。故仅生产模式自动打开浏览器，
  // dev 模式改为提示 Vite 开发服务器地址。
  if (shouldOpenBrowser) {
    if (isProduction) {
      // Small delay to ensure server is ready
      setTimeout(async () => {
        console.log('Opening dashboard in your browser...');
        try {
          const { default: open } = await import('open');
          await open(`http://127.0.0.1:${port}`);
        } catch (err: any) {
          console.warn('Could not open browser:', err.message);
        }
      }, 100);
    } else {
      console.log('Development mode: open http://localhost:5173/ in your browser (Vite dev server).');
    }
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

// 仅当文件被直接执行时调用（tsx watch / node index.js）；
// bin/tokendash.js 通过 import { main } 自行调用，不触发此处。
// process.argv[1] 在部分运行时（如 REPL、嵌入式调用）可能为空，先守卫再转换。
const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
