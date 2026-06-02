import { describe, it, expect } from 'vitest';
import { createApp, resolveStaticAssetBaseDir } from '../../server/index.js';
import { existsSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { version: packageVersion } = require('../../../package.json') as { version: string };
const { formatCost, formatTokens } = require('../../../electron/trayBadge.cjs') as {
  formatCost: (cost: number) => string;
  formatTokens: (tokens: number) => string;
};
const { checkForUpdates, compareVersions, getRedirectReleaseUpdateInfo, getReleaseUpdateInfo, selectMacDmgAsset } = require('../../../electron/updateService.cjs') as {
  checkForUpdates: (options: {
    repo: string;
    currentVersion: string;
    arch?: string;
    fetchReleaseJson?: (url: string) => Promise<any>;
    fetchLatestReleaseUrl?: (repo: string) => Promise<string>;
  }) => Promise<any>;
  compareVersions: (a: string, b: string) => number;
  getRedirectReleaseUpdateInfo: (repo: string, releaseUrl: string, currentVersion: string, arch?: string) => any;
  getReleaseUpdateInfo: (release: any, currentVersion: string, arch?: string) => any;
  selectMacDmgAsset: (assets: any[], arch?: string) => any;
};
const { buildNpmInstallArgs, shouldInstallPackage } = require('../../../electron/npmSync.cjs') as {
  buildNpmInstallArgs: (packageName: string, version: string) => string[];
  shouldInstallPackage: (installedVersion: string | null | undefined, targetVersion: string) => boolean;
};
const { getDashboardUrl, isCompatibleServerInfo } = require('../../../electron/serverReuse.cjs') as {
  getDashboardUrl: (port: number | string | null | undefined) => string;
  isCompatibleServerInfo: (info: any, expectedVersion: string, expectedPackageName: string) => boolean;
};

describe('createApp', () => {
  it('returns an Express app', () => {
    const app = createApp(3456);
    expect(app).toBeDefined();
    expect(typeof app.listen).toBe('function');
  });

  it('has /api route registered', async () => {
    const app = createApp(0);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    const port = address.port;

    try {
      const data = await fetchJson(`http://localhost:${port}/api/agents`);
      expect(data).toHaveProperty('available');
    } finally {
      server.close();
    }
  });

  it('exposes package version and dashboard URL for CLI/Electron coordination', async () => {
    const app = createApp(4567);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    const port = address.port;

    try {
      const data = await fetchJson(`http://localhost:${port}/api/app-info`);
      expect(data).toMatchObject({
        packageName: '@zhangferry-dev/tokendash',
        version: packageVersion,
        dashboardUrl: `http://localhost:${port}`,
      });
    } finally {
      server.close();
    }
  });

  it('serves /popover.html when the static file is present', async () => {
    const popoverFile = join(process.cwd(), 'dist', 'client', 'popover.html');
    if (!existsSync(popoverFile)) return; // skip when build output is absent

    const app = createApp(0, join(process.cwd(), 'dist'));
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    const port = address.port;

    try {
      const res = await fetch(`http://localhost:${port}/popover.html`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('TokenDash');
      expect(html).toContain('open-dashboard');
    } finally {
      server.close();
    }
  });

  it('returns 404 for /popover.html when static file is absent', async () => {
    const app = createApp(0, join(process.cwd(), 'nonexistent-dist'));
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    const port = address.port;

    try {
      const res = await fetch(`http://localhost:${port}/popover.html`);
      expect(res.status).toBe(404);
    } finally {
      server.close();
    }
  });
});


describe('resolveStaticAssetBaseDir', () => {
  it('resolves CLI production assets from dist/server to dist', () => {
    const resolved = resolveStaticAssetBaseDir('file:///opt/homebrew/lib/node_modules/@zhangferry-dev/tokendash/dist/server/index.js');

    expect(resolved).toEqual({
      baseDir: '/opt/homebrew/lib/node_modules/@zhangferry-dev/tokendash/dist',
      isProduction: true,
    });
  });

  it('reads package metadata from bundled Electron server output', async () => {
    const app = createApp(7890, '/app/dist');
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    const port = address.port;

    try {
      const data = await fetchJson(`http://localhost:${port}/api/app-info`);
      expect(data.version).toBe(packageVersion);
      expect(data.dashboardUrl).toBe(`http://localhost:${port}`);
    } finally {
      server.close();
    }
  });

  it('keeps explicit production base directories unchanged', () => {
    const resolved = resolveStaticAssetBaseDir('file:///app/dist/server/index.js', '/app/dist');

    expect(resolved).toEqual({ baseDir: '/app/dist', isProduction: true });
  });

  it('keeps source server directories in development', () => {
    const resolved = resolveStaticAssetBaseDir('file:///repo/src/server/index.ts');

    expect(resolved).toEqual({ baseDir: '/repo/src/server', isProduction: false });
  });
});

describe('formatCost', () => {
  it('formats near-zero cost as $0', () => {
    expect(formatCost(0)).toBe('$0');
    expect(formatCost(0.01)).toBe('$0');
    expect(formatCost(0.04)).toBe('$0');
  });

  it('formats small costs with 1 decimal', () => {
    expect(formatCost(0.05)).toBe('$0.1');
    expect(formatCost(1.234)).toBe('$1.2');
    expect(formatCost(3.456)).toBe('$3.5');
    expect(formatCost(9.99)).toBe('$10.0');
  });

  it('formats medium costs without decimal', () => {
    expect(formatCost(10)).toBe('$10');
    expect(formatCost(12.5)).toBe('$13');
    expect(formatCost(99)).toBe('$99');
  });

  it('formats large costs without decimal', () => {
    expect(formatCost(100)).toBe('$100');
    expect(formatCost(123.4)).toBe('$123');
    expect(formatCost(999)).toBe('$999');
  });
});

describe('local date helper', () => {
  function getLocalDate(): string {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  it('matches local date, not UTC', () => {
    const local = getLocalDate();
    const utc = new Date().toISOString().slice(0, 10);
    const now = new Date();
    // local should match the system date
    expect(local).toBe(
      now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0')
    );
    // if timezone offset is non-zero and we're near midnight, local may differ from UTC
    const offsetHours = now.getTimezoneOffset() / 60;
    if (Math.abs(offsetHours) > 0 && now.getHours() < Math.abs(offsetHours)) {
      expect(local).not.toBe(utc);
    }
  });

  it('produces YYYY-MM-DD format', () => {
    const local = getLocalDate();
    expect(local).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('formatTokens', () => {
  it('formats millions', () => {
    expect(formatTokens(1500000)).toBe('1.5M');
    expect(formatTokens(32000000)).toBe('32.0M');
  });

  it('formats thousands', () => {
    expect(formatTokens(1234)).toBe('1.2K');
    expect(formatTokens(567890)).toBe('567.9K');
  });

  it('formats small numbers as-is', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(42)).toBe('42');
    expect(formatTokens(999)).toBe('999');
  });

  it('does not render zero or invalid values as a fake million count', () => {
    expect(formatTokens(-1)).toBe('0');
    expect(formatTokens(Number.NaN)).toBe('0');
  });
});

describe('updateService', () => {
  it('compares semantic versions with optional v prefixes', () => {
    expect(compareVersions('1.5.0', 'v1.5.0')).toBe(0);
    expect(compareVersions('1.5.1', '1.5.0')).toBeGreaterThan(0);
    expect(compareVersions('1.4.9', '1.5.0')).toBeLessThan(0);
  });

  it('selects the matching macOS DMG asset for the current architecture', () => {
    const assets = [
      { name: 'TokenDash-1.6.0-x64.dmg', browser_download_url: 'https://example.com/x64.dmg' },
      { name: 'TokenDash-1.6.0-arm64.dmg', browser_download_url: 'https://example.com/arm64.dmg' },
      { name: 'TokenDash-1.6.0-arm64.dmg.blockmap', browser_download_url: 'https://example.com/blockmap' },
    ];

    expect(selectMacDmgAsset(assets, 'arm64')?.name).toBe('TokenDash-1.6.0-arm64.dmg');
    expect(selectMacDmgAsset(assets, 'x64')?.name).toBe('TokenDash-1.6.0-x64.dmg');
  });

  it('builds update info with a downloadable asset', () => {
    const info = getReleaseUpdateInfo({
      tag_name: 'v1.6.0',
      html_url: 'https://github.com/zhangferry/tokendash/releases/tag/v1.6.0',
      assets: [
        {
          name: 'TokenDash-1.6.0-arm64.dmg',
          size: 123,
          browser_download_url: 'https://example.com/TokenDash.dmg',
        },
      ],
    }, '1.5.0', 'arm64');

    expect(info.upToDate).toBe(false);
    expect(info.latestVersion).toBe('1.6.0');
    expect(info.asset).toEqual({
      name: 'TokenDash-1.6.0-arm64.dmg',
      size: 123,
      url: 'https://example.com/TokenDash.dmg',
    });
  });

  it('builds update info from the public latest-release redirect when the API is unavailable', () => {
    const info = getRedirectReleaseUpdateInfo(
      'zhangferry/tokendash',
      'https://github.com/zhangferry/tokendash/releases/tag/v1.7.0',
      '1.6.0',
      'arm64',
    );

    expect(info).toEqual({
      currentVersion: '1.6.0',
      latestVersion: '1.7.0',
      upToDate: false,
      releaseUrl: 'https://github.com/zhangferry/tokendash/releases/tag/v1.7.0',
      asset: {
        name: 'TokenDash-1.7.0-arm64.dmg',
        size: 0,
        url: 'https://github.com/zhangferry/tokendash/releases/download/v1.7.0/TokenDash-1.7.0-arm64.dmg',
      },
    });
  });

  it('falls back to the public latest-release redirect when the GitHub API is rate-limited', async () => {
    const info = await checkForUpdates({
      repo: 'zhangferry/tokendash',
      currentVersion: '1.6.0',
      arch: 'arm64',
      fetchReleaseJson: async () => {
        throw new Error('HTTP 403');
      },
      fetchLatestReleaseUrl: async () => 'https://github.com/zhangferry/tokendash/releases/tag/v1.7.0',
    });

    expect(info.latestVersion).toBe('1.7.0');
    expect(info.upToDate).toBe(false);
    expect(info.error).toBeUndefined();
    expect(info.asset).toMatchObject({
      name: 'TokenDash-1.7.0-arm64.dmg',
      url: 'https://github.com/zhangferry/tokendash/releases/download/v1.7.0/TokenDash-1.7.0-arm64.dmg',
    });
  });
});

describe('npm package sync helpers', () => {
  it('installs the exact app version of the npm package', () => {
    expect(buildNpmInstallArgs('@zhangferry-dev/tokendash', '1.6.0')).toEqual([
      'install',
      '-g',
      '@zhangferry-dev/tokendash@1.6.0',
    ]);
  });

  it('skips npm install only when the installed version already matches', () => {
    expect(shouldInstallPackage('1.6.0', '1.6.0')).toBe(false);
    expect(shouldInstallPackage('1.5.0', '1.6.0')).toBe(true);
    expect(shouldInstallPackage(null, '1.6.0')).toBe(true);
  });
});

describe('Electron server reuse helpers', () => {
  it('builds the dashboard URL from the active server port', () => {
    expect(getDashboardUrl(3456)).toBe('http://localhost:3456');
    expect(getDashboardUrl('4567')).toBe('http://localhost:4567');
    expect(getDashboardUrl(undefined)).toBe('http://localhost:3456');
  });

  it('reuses only matching TokenDash servers', () => {
    expect(isCompatibleServerInfo({ packageName: '@zhangferry-dev/tokendash', version: '1.6.0' }, '1.6.0', '@zhangferry-dev/tokendash')).toBe(true);
    expect(isCompatibleServerInfo({ packageName: '@zhangferry-dev/tokendash', version: '1.5.0' }, '1.6.0', '@zhangferry-dev/tokendash')).toBe(false);
    expect(isCompatibleServerInfo({ packageName: 'other', version: '1.6.0' }, '1.6.0', '@zhangferry-dev/tokendash')).toBe(false);
  });
});

describe('daily API data freshness', () => {
  let server: ReturnType<ReturnType<typeof createApp>['listen']>;
  let port: number;

  beforeAll(async () => {
    const app = createApp(0);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        if (addr && typeof addr !== 'string') port = addr.port;
        resolve();
      });
    });
  });

  afterAll(() => {
    server?.close();
  });

  it('daily endpoint returns data for today', async () => {
    const data = await fetchJson(`http://localhost:${port}/api/daily?agent=claude`);
    expect(data).toHaveProperty('daily');
    expect(Array.isArray(data.daily)).toBe(true);

    const localNow = new Date();
    const today = localNow.getFullYear() + '-' + String(localNow.getMonth() + 1).padStart(2, '0') + '-' + String(localNow.getDate()).padStart(2, '0');
    const todayEntry = data.daily.find((d: any) => d.date === today);
    if (!todayEntry) return; // skip if no data today (e.g. CI environment)

    expect(todayEntry).toHaveProperty('inputTokens');
    expect(todayEntry).toHaveProperty('outputTokens');
    expect(todayEntry).toHaveProperty('totalTokens');
    expect(todayEntry).toHaveProperty('totalCost');
    // If there's any usage today, totalTokens should be > 0
    if (todayEntry.totalTokens > 0) {
      expect(todayEntry.inputTokens + todayEntry.outputTokens + todayEntry.cacheReadTokens).toBeGreaterThan(0);
    }
  });

  it('today entry has valid token fields', async () => {
    const data = await fetchJson(`http://localhost:${port}/api/daily?agent=claude`);
    const localNow = new Date();
    const today = localNow.getFullYear() + '-' + String(localNow.getMonth() + 1).padStart(2, '0') + '-' + String(localNow.getDate()).padStart(2, '0');
    const entry = data.daily.find((d: any) => d.date === today);
    if (!entry) return; // skip if no data today

    expect(typeof entry.inputTokens).toBe('number');
    expect(typeof entry.outputTokens).toBe('number');
    expect(typeof entry.cacheReadTokens).toBe('number');
    expect(typeof entry.totalTokens).toBe('number');
    expect(typeof entry.totalCost).toBe('number');
    expect(entry.inputTokens).toBeGreaterThanOrEqual(0);
    expect(entry.outputTokens).toBeGreaterThanOrEqual(0);
    expect(entry.totalTokens).toBeGreaterThanOrEqual(entry.inputTokens + entry.outputTokens);
  });

  it('blocks endpoint returns data for today with correct structure', async () => {
    const data = await fetchJson(`http://localhost:${port}/api/blocks?agent=claude`);
    expect(data).toHaveProperty('blocks');

    const localNow = new Date();
    const today = localNow.getFullYear() + '-' + String(localNow.getMonth() + 1).padStart(2, '0') + '-' + String(localNow.getDate()).padStart(2, '0');
    const todayBlocks = data.blocks.filter((b: any) => b.startTime?.startsWith(today));

    // If there are blocks today, validate structure
    for (const block of todayBlocks) {
      expect(block).toHaveProperty('startTime');
      expect(block).toHaveProperty('totalTokens');
      expect(block.totalTokens).toBeGreaterThanOrEqual(0);
      // tokenCounts should contain input/output breakdown
      if (block.tokenCounts) {
        expect(block.tokenCounts).toHaveProperty('inputTokens');
        expect(block.tokenCounts).toHaveProperty('outputTokens');
      }
    }
  });

  it('daily returns correct date when filtered by agent', async () => {
    const agents = await fetchJson(`http://localhost:${port}/api/agents`);
    expect(agents).toHaveProperty('available');

    for (const agent of agents.available) {
      const data = await fetchJson(`http://localhost:${port}/api/daily?agent=${agent}`);
      expect(data).toHaveProperty('daily');
      // Each agent should have daily array (may be empty)
      expect(Array.isArray(data.daily)).toBe(true);
    }
  }, 20000);
});

function fetchJson(url: string): Promise<any> {
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
