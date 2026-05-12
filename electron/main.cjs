const { app, BrowserWindow, ipcMain, screen, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const { spawn } = require('node:child_process');

// Global debug logger (writes to file since stdout is lost in packaged apps)
const DEBUG_LOG = '/tmp/tokendash-debug.log';
try { fs.writeFileSync(DEBUG_LOG, 'main.js loaded\n'); } catch(_){}

// Import from bundled server (created by esbuild)
let createApp;
try {
  createApp = require('../dist/electron-server.cjs').createApp;
} catch (e) {
  console.error('Failed to load bundled server. Did you run the build?', e.message);
  app.quit();
}

const { formatTokens } = require('./trayBadge.cjs');

// Resolve trayHelper binary: extract from asar if needed
function resolveTrayHelperPath() {
  const srcPath = path.join(__dirname, 'trayHelper');
  const isAsar = srcPath.includes('.asar');
  const debugLog = (msg) => {
    const logPath = '/tmp/tokendash-debug.log';
    fs.appendFileSync(logPath, msg + '\n');
  };
  debugLog('[trayHelper] __dirname: ' + __dirname);
  debugLog('[trayHelper] srcPath: ' + srcPath + ' isAsar: ' + isAsar);
  if (isAsar) {
    const destDir = path.join(app.getPath('userData'), 'helpers');
    const destPath = path.join(destDir, 'trayHelper');
    debugLog('[trayHelper] extracting to: ' + destPath);
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(srcPath, destPath);
    fs.chmodSync(destPath, 0o755);
    debugLog('[trayHelper] extracted OK');
    return destPath;
  }
  return srcPath;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let popover = null;
let server = null;
let trayProcess = null;
let selectedAgents = null; // null = use all available agents
let serverPort = parseInt(process.env.TOKENDASH_PORT || '3456', 10);
const POPOVER_WIDTH = 380;
const POPOVER_HEIGHT = 540;
const PACKAGE_NAME = '@zhangferry-dev/tokendash';
const GITHUB_REPO = 'zhangferry/tokendash';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function listenWithFallback(expressApp, port) {
  return new Promise((resolve, reject) => {
    let currentPort = port;
    let attempts = 0;

    function tryListen() {
      const s = expressApp.listen(currentPort);
      s.once('listening', () => resolve({ server: s, port: currentPort }));
      s.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && attempts < 20) {
          attempts++;
          currentPort++;
          tryListen();
        } else {
          reject(err);
        }
      });
    }

    tryListen();
  });
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function fetchHttpsJson(url) {
  return new Promise((resolve, reject) => {
    const opts = new URL(url);
    const reqOpts = {
      hostname: opts.hostname,
      path: opts.pathname + opts.search,
      method: 'GET',
      headers: { 'User-Agent': 'TokenDash' },
    };
    https.get(reqOpts, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function compareVersions(a, b) {
  const aParts = String(a).split('.').map((part) => parseInt(part, 10) || 0);
  const bParts = String(b).split('.').map((part) => parseInt(part, 10) || 0);
  const maxLen = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < maxLen; i++) {
    const delta = (aParts[i] || 0) - (bParts[i] || 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function getAppInfo() {
  // app.getVersion() returns Electron's version in dev mode (e.g. 41.5).
  // Always read from package.json to get the app's own version.
  let version = app.getVersion();
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    if (pkg.version) version = pkg.version;
  } catch (_) {}
  return {
    version,
    launchAtLogin: app.getLoginItemSettings().openAtLogin,
    platform: process.platform,
    packageName: PACKAGE_NAME,
  };
}

function positionPopoverAtClick(clickScreenX) {
  if (!popover) return;

  // Find which display the click is on
  const allDisplays = screen.getAllDisplays();
  const clickDisplay = allDisplays.find(d => {
    const bounds = d.bounds;
    return clickScreenX >= bounds.x && clickScreenX < bounds.x + bounds.width;
  }) || screen.getPrimaryDisplay();

  const { x: screenX, y: screenY, width: screenW, height: screenH } = clickDisplay.workArea;
  const popoverWidth = POPOVER_WIDTH;
  const popoverHeight = POPOVER_HEIGHT;

  // Center horizontally on click position
  let x = clickScreenX - popoverWidth / 2;
  // Below menu bar, close to the icon
  let y = screenY + 6;

  // Clamp to screen bounds
  if (x < screenX + 8) x = screenX + 8;
  if (x + popoverWidth > screenX + screenW - 8) x = screenX + screenW - popoverWidth - 8;
  if (y + popoverHeight > screenY + screenH - 8) y = screenY + screenH - popoverHeight - 8;

  popover.setPosition(Math.round(x), Math.round(y), false);
}

function togglePopover(clickScreenX) {
  if (!popover) return;

  if (popover.isVisible()) {
    popover.hide();
  } else {
    positionPopoverAtClick(clickScreenX || 0);
    popover.show();
    popover.focus();
  }
}

// ---------------------------------------------------------------------------
// Native tray helper (Swift binary for macOS 26+ compatibility)
// ---------------------------------------------------------------------------

function startTrayHelper() {
  const helperPath = resolveTrayHelperPath();
  trayProcess = spawn(helperPath, [], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  let buffer = '';

  trayProcess.stdout.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete line in buffer

    for (const line of lines) {
      const event = line.trim();
      if (event.startsWith('click:')) {
        // Format: click:x,y (screen coordinates in macOS points)
        const parts = event.split(':')[1];
        const clickX = parseInt(parts.split(',')[0], 10) || 0;
        // Convert macOS screen coords (origin bottom-left) to top-left for Electron
        const primaryDisplay = screen.getPrimaryDisplay();
        const screenH = primaryDisplay.size.height;
        togglePopover(clickX);
      } else if (event === 'ready') {
        // Helper is ready, start badge updates
        startBadgeUpdates();
      }
    }
  });

  trayProcess.on('close', (code) => {
    console.log('Tray helper exited with code', code);
    trayProcess = null;
  });

  trayProcess.on('error', (err) => {
    console.error('Failed to start tray helper:', err.message);
    trayProcess = null;
  });
}

function sendTrayCommand(command) {
  if (trayProcess && trayProcess.stdin && !trayProcess.stdin.destroyed) {
    trayProcess.stdin.write(command + '\n');
  }
}

function stopTrayHelper() {
  if (trayProcess) {
    sendTrayCommand('quit');
    trayProcess = null;
  }
}

// ---------------------------------------------------------------------------
// Tray badge updater
// ---------------------------------------------------------------------------

let updateTimer = null;
let lastTraySnapshot = null;

function getTrayAgentKey(agents) {
  return agents.slice().sort().join(',');
}

function applyTraySnapshot(snapshot) {
  const totalTokens = Number(snapshot && snapshot.totalTokens) || 0;
  const totalCost = Number(snapshot && snapshot.totalCost) || 0;
  const totalCacheRead = Number(snapshot && snapshot.totalCacheRead) || 0;
  const today = snapshot && snapshot.today;
  const agentKey = snapshot && snapshot.agentKey;

  lastTraySnapshot = { today, agentKey, totalTokens, totalCost, totalCacheRead };

  const tokenStr = formatTokens(totalTokens);
  sendTrayCommand('title:' + tokenStr);

  const cacheRate = totalTokens > 0 ? ((totalCacheRead / totalTokens) * 100).toFixed(1) : '0.0';
  sendTrayCommand('tooltip:TokenDash - ' + tokenStr + ' tokens today ($' + totalCost.toFixed(2) + ') | cache: ' + cacheRate + '%');
}

function updateTrayBadge() {
  const d = new Date(); const today = d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0");

  // Fetch agents list, then fetch daily data for each agent in parallel
  fetchJson(`http://localhost:${serverPort}/api/agents`)
    .then((agentData) => {
      let agents = (agentData && Array.isArray(agentData.available)) ? agentData.available : ['claude'];
      if (agents.length === 0) {
        // Transient agent detection failures should not clear a previously valid tray badge.
        return null;
      }

      // Apply agent filter from popover settings
      if (selectedAgents && selectedAgents.length > 0) {
        const filtered = agents.filter(a => selectedAgents.includes(a));
        if (filtered.length > 0) agents = filtered;
      }

      const agentKey = getTrayAgentKey(agents);
      return Promise.all(
        agents.map(agent =>
          fetchJson(`http://localhost:${serverPort}/api/daily?agent=${agent}`)
            .catch(() => null)
        )
      ).then(results => ({ agentKey, results }));
    })
    .then((payload) => {
      if (!payload) return;
      const { agentKey, results } = payload;
      const successfulResults = results.filter(data => data && data.daily);
      if (successfulResults.length === 0) {
        // Keep the last good value when every daily request failed.
        return;
      }

      let totalTokens = 0;
      let totalCost = 0;
      let totalInput = 0;
      let totalOutput = 0;
      let totalCacheRead = 0;

      for (const data of results) {
        if (!data || !data.daily) continue;
        const entry = data.daily.find(d => d.date === today);
        if (!entry) continue;
        totalTokens += entry.totalTokens || 0;
        totalCost += entry.totalCost || 0;
        totalInput += entry.inputTokens || 0;
        totalOutput += entry.outputTokens || 0;
        totalCacheRead += entry.cacheReadTokens || 0;
      }

      const shouldPreserveLastPositive =
        totalTokens === 0 &&
        lastTraySnapshot &&
        lastTraySnapshot.today === today &&
        lastTraySnapshot.agentKey === agentKey &&
        lastTraySnapshot.totalTokens > 0;

      if (shouldPreserveLastPositive) {
        // Daily usage should not drop to zero during the same day for the same agent filter.
        // Treat a zero refresh after a positive value as transient empty data and keep the badge stable.
        return;
      }

      applyTraySnapshot({ today, agentKey, totalTokens, totalCost, totalCacheRead });
    })
    .catch((err) => {
      if (err.code !== 'ECONNREFUSED') {
        console.error('Tray badge update error:', err.message);
      }
    });
}

function startBadgeUpdates() {
  updateTrayBadge();
  updateTimer = setInterval(updateTrayBadge, 5000);
}

function stopBadgeUpdates() {
  if (updateTimer) {
    clearInterval(updateTimer);
    updateTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Create popover window
// ---------------------------------------------------------------------------

function createPopoverWindow() {
  popover = new BrowserWindow({
    width: POPOVER_WIDTH,
    height: POPOVER_HEIGHT,
    frame: false,
    resizable: false,
    hasShadow: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    fullscreenable: false,
    transparent: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  popover.loadURL(`http://localhost:${serverPort}/popover.html`);

  popover.on('blur', () => {
    popover.hide();
  });

  popover.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      popover.hide();
    }
  });
}

function registerIpcHandlers() {
  ipcMain.handle('tokendash:open-dashboard', (_event, url) => {
    const target = typeof url === 'string' && url.length > 0 ? url : `http://localhost:${serverPort}`;
    return shell.openExternal(target);
  });

  ipcMain.handle('tokendash:get-app-info', () => {
    return getAppInfo();
  });

  ipcMain.handle('tokendash:set-launch-at-login', (_event, enabled) => {
    const openAtLogin = Boolean(enabled);
    app.setLoginItemSettings({ openAtLogin });
    return { launchAtLogin: app.getLoginItemSettings().openAtLogin };
  });

  ipcMain.handle('tokendash:check-for-updates', async () => {
    const currentVersion = getAppInfo().version;
    const releasesUrl = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

    try {
      const latest = await fetchHttpsJson(releasesUrl);
      // GitHub release tag may be "v1.3.0" or "1.3.0"
      const tag = (latest.tag_name || '').replace(/^v/, '');
      const latestVersion = tag || currentVersion;
      return {
        currentVersion,
        latestVersion,
        upToDate: compareVersions(currentVersion, latestVersion) >= 0,
        releaseUrl: latest.html_url || null,
      };
    } catch (error) {
      return {
        currentVersion,
        latestVersion: currentVersion,
        upToDate: true,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  ipcMain.handle('tokendash:quit', () => {
    app.isQuitting = true;
    stopBadgeUpdates();
    stopTrayHelper();
    if (server) server.close();
    app.quit();
  });

  ipcMain.handle('tokendash:set-selected-agents', (_event, agents) => {
    selectedAgents = Array.isArray(agents) ? agents : null;
    lastTraySnapshot = null;
    // Immediately refresh badge with new filter
    updateTrayBadge();
    return { ok: true };
  });

  ipcMain.handle('tokendash:update-tray-snapshot', (_event, snapshot) => {
    if (!snapshot || typeof snapshot !== 'object') return { ok: false };
    applyTraySnapshot(snapshot);
    return { ok: true };
  });
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(async () => {
  if (process.platform === 'darwin' && app.dock) {
    app.dock.hide();
  }

  registerIpcHandlers();

  app.on('before-quit', () => {
    app.isQuitting = true;
    stopBadgeUpdates();
    stopTrayHelper();
    if (server) server.close();
  });

  // Create and bind Express server
  // Pass dist/ directory so createApp resolves client assets correctly
  const distDir = path.join(__dirname, '..', 'dist');
  const expressApp = createApp(serverPort, distDir);
  try {
    const result = await listenWithFallback(expressApp, serverPort);
    server = result.server;
    serverPort = result.port;
    console.log(`tokendash running on http://localhost:${result.port}`);
  } catch (err) {
    console.error('Failed to start server:', err);
    app.quit();
    return;
  }

  // Start native tray helper
  startTrayHelper();

  // Create popover
  createPopoverWindow();
});

process.on('uncaughtException', (err) => {
  console.error('Fatal error in Electron main:', err);
  app.quit();
});
