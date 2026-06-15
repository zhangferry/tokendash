/**
 * TokenDash Daemon — headless Node.js server for the Swift menu bar app.
 *
 * Usage: node dist/daemon.cjs [--port <number>]
 *
 * The Swift app spawns this process and manages its lifecycle.
 * Communication happens via:
 *   - ~/.tokendash/daemon.pid  — PID file (for process management)
 *   - ~/.tokendash/daemon.port — actual listening port (for Swift discovery)
 *   - 127.0.0.1 HTTP API       — all existing /api/* routes
 */

import { createApp } from './index.js';
import type { Express } from 'express';
import http from 'node:http';
import type { Server } from 'node:http';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const TOKEN_DASH_HOST = '127.0.0.1';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const DATA_DIR = join(homedir(), '.tokendash');
const PID_FILE = join(DATA_DIR, 'daemon.pid');
const PORT_FILE = join(DATA_DIR, 'daemon.port');

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function writePidFile() {
  ensureDataDir();
  writeFileSync(PID_FILE, String(process.pid), 'utf8');
}

function writePortFile(port: number) {
  ensureDataDir();
  writeFileSync(PORT_FILE, String(port), 'utf8');
}

function cleanupFiles() {
  try { if (existsSync(PID_FILE)) unlinkSync(PID_FILE); } catch (_) {}
  try { if (existsSync(PORT_FILE)) unlinkSync(PORT_FILE); } catch (_) {}
}

// ---------------------------------------------------------------------------
// Port fallback
// ---------------------------------------------------------------------------

function resolvePort(): number {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && i + 1 < args.length) {
      const v = parseInt(args[i + 1], 10);
      if (Number.isInteger(v) && v > 0) return v;
    }
  }
  const envPort = process.env.TOKENDASH_PORT ? parseInt(process.env.TOKENDASH_PORT, 10) : 0;
  if (Number.isInteger(envPort) && envPort > 0) return envPort;
  return 3456;
}

function listen(app: Express, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, TOKEN_DASH_HOST);
    const onListen = () => { cleanup(); resolve(server); };
    const onError = (err: Error) => { cleanup(); reject(err); };
    const cleanup = () => { server.off('listening', onListen); server.off('error', onError); };
    server.once('listening', onListen);
    server.once('error', onError);
  });
}

export async function listenWithFallback(app: Express, preferredPort: number): Promise<{ server: Server; port: number }> {
  let port = preferredPort;
  for (let attempt = 0; attempt < 20; attempt++, port++) {
    try {
      const server = await listen(app, port);
      return { server, port };
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error(`No available port starting from ${preferredPort}`);
}

// ---------------------------------------------------------------------------
// Stale daemon check
// ---------------------------------------------------------------------------

function killStaleDaemon(): boolean {
  if (!existsSync(PID_FILE)) return false;
  try {
    const pid = parseInt(readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    // Send SIGTERM to stale process (throws if PID doesn't exist)
    process.kill(pid, 0); // check if alive
    // Process exists — try to kill it
    process.kill(pid, 'SIGTERM');
    // Give it a moment
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      try { process.kill(pid, 0); } catch { break; }
    }
    return true;
  } catch {
    // Process doesn't exist — stale PID file
    cleanupFiles();
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Kill any stale daemon
  killStaleDaemon();

  const preferredPort = resolvePort();
  const distDir = join(import.meta.url.replace('file://', ''), '..');

  const app = createApp(preferredPort, distDir);
  const { server, port } = await listenWithFallback(app, preferredPort);

  writePidFile();
  writePortFile(port);

  // Warm up cache: pre-parse JSONL for all agents so first Swift fetch is fast
  try {
    const agentsRes = await new Promise<any>((resolve, reject) => {
      http.get(`http://${TOKEN_DASH_HOST}:${port}/api/agents`, (res) => {
        let body = '';
        res.on('data', (chunk: string) => { body += chunk; });
        res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
      }).on('error', reject);
    });
    const agents: string[] = agentsRes?.available ?? ['claude'];
    await Promise.all(agents.map((agent: string) => new Promise<void>((resolve) => {
      http.get(`http://${TOKEN_DASH_HOST}:${port}/api/daily?agent=${agent}`, (res) => {
        res.resume(); res.on('end', () => resolve());
      }).on('error', () => resolve());
    })));
  } catch (_) {
    // Warm-up is best-effort; don't block startup
  }

  // Graceful shutdown
  const shutdown = () => {
    cleanupFiles();
    server.close(() => process.exit(0));
    // Force exit after 5s if server.close hangs
    setTimeout(() => process.exit(0), 5000);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('uncaughtException', (err) => {
    console.error('[tokendash-daemon] uncaught:', err);
    shutdown();
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('[tokendash-daemon] fatal:', err);
    cleanupFiles();
    process.exit(1);
  });
}
