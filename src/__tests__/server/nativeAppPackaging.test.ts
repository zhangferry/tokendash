import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

describe('native app packaging resources', () => {
  it('keeps the menu bar badge as a compact adaptive template image', () => {
    const badgeUpdater = readFileSync('TokenDashSwift/Sources/TokenDash/BadgeUpdater.swift', 'utf8');
    expect(badgeUpdater).toContain('NSBezierPath(ovalIn: circleRect).fill()');
    expect(badgeUpdater).toContain('.foregroundColor: NSColor.black');
    expect(badgeUpdater).toContain('NSColor.black.setFill()');
    expect(badgeUpdater).toContain('image.isTemplate = true');
  });

  it('builds the app icon from the rounded transparent source asset', () => {
    const iconScript = readFileSync('scripts/generate-icon.sh', 'utf8');
    expect(iconScript).toContain('SOURCE_ICON="$REPO_ROOT/resources/icon.png"');
    expect(iconScript).toContain('iconutil -c icns');
    expect(iconScript).toContain('icon_512x512@2x.png');
  });

  it('uses one adaptive background token for the native popover and header', () => {
    const helpers = readFileSync('TokenDashSwift/Sources/TokenDash/Helpers.swift', 'utf8');
    expect(helpers).toContain('Color(nsColor: .windowBackgroundColor)');
    expect(helpers).not.toContain('NSColor(name:');
    expect(helpers).not.toContain('case .light:');
    expect(helpers).not.toContain('case .dark:');
  });

  it('does not signal an unrelated process from stale daemon state', () => {
    const daemonManager = readFileSync('TokenDashSwift/Sources/TokenDash/DaemonManager.swift', 'utf8');
    expect(daemonManager).toContain('cleanupIncompatibleDaemon');
    expect(daemonManager).toContain('isTokenDashDaemonProcess(pid: pid)');
    expect(daemonManager).toContain('case .unavailableOrForeign:');
    expect(daemonManager).toContain('cleanupFiles()');
  });

  it('signs Sparkle components in the correct order for packaged apps', () => {
    const packageApp = readFileSync('scripts/package-app.sh', 'utf8');
    expect(packageApp).toContain('XPCServices/Installer.xpc');
    expect(packageApp).toContain('XPCServices/Downloader.xpc');
    expect(packageApp).toContain('--preserve-metadata=entitlements');
    expect(packageApp).toContain('Updater.app');
  });

  it('bumps Sparkle build numbers past the latest published appcast', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokendash-appcast-'));
    const curlStub = join(tempDir, 'curl');
    writeFileSync(curlStub, `#!/bin/sh
cat <<'XML'
<?xml version="1.0" standalone="yes"?>
<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" version="2.0">
  <channel>
    <item>
      <sparkle:version>106</sparkle:version>
      <sparkle:shortVersionString>1.8.1</sparkle:shortVersionString>
    </item>
  </channel>
</rss>
XML
`, { mode: 0o755 });

    const resolved = execFileSync('bash', ['scripts/resolve-sparkle-build-number.sh'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BUILD_NUMBER: '87',
        CURL_BIN: curlStub,
        GH_BIN: join(tempDir, 'missing-gh'),
      },
      encoding: 'utf8',
    }).trim();

    expect(resolved).toBe('107');
  });

  it('uses recent release appcasts when the latest appcast build number regressed', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokendash-appcast-'));
    const curlStub = join(tempDir, 'curl');
    writeFileSync(curlStub, `#!/bin/bash
url="\${@: -1}"
case "$url" in
  *releases/latest/download/appcast.xml)
    cat <<'XML'
<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" version="2.0">
  <channel><item><sparkle:version>87</sparkle:version></item></channel>
</rss>
XML
    ;;
  *api.github.com*)
    cat <<'JSON'
[
  {"assets":[{"name":"appcast.xml","browser_download_url":"https://example.com/v1.8.2/appcast.xml"}]},
  {"assets":[{"name":"appcast.xml","browser_download_url":"https://example.com/v1.8.1/appcast.xml"}]}
]
JSON
    ;;
  *v1.8.2*)
    cat <<'XML'
<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><item><sparkle:version>87</sparkle:version></item></channel></rss>
XML
    ;;
  *v1.8.1*)
    cat <<'XML'
<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><item><sparkle:version>106</sparkle:version></item></channel></rss>
XML
    ;;
esac
`, { mode: 0o755 });

    const resolved = execFileSync('bash', ['scripts/resolve-sparkle-build-number.sh'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BUILD_NUMBER: '87',
        CURL_BIN: curlStub,
        GH_BIN: join(tempDir, 'missing-gh'),
      },
      encoding: 'utf8',
    }).trim();

    expect(resolved).toBe('107');
  });

  it('keeps a higher local Sparkle build number when the published appcast is older', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokendash-appcast-'));
    const curlStub = join(tempDir, 'curl');
    writeFileSync(curlStub, `#!/bin/sh
cat <<'XML'
<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" version="2.0">
  <channel><item><sparkle:version>106</sparkle:version></item></channel>
</rss>
XML
`, { mode: 0o755 });

    const resolved = execFileSync('bash', ['scripts/resolve-sparkle-build-number.sh'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BUILD_NUMBER: '118',
        CURL_BIN: curlStub,
        GH_BIN: join(tempDir, 'missing-gh'),
      },
      encoding: 'utf8',
    }).trim();

    expect(resolved).toBe('118');
  });

  it('fails strict release builds when recent appcasts cannot be inspected', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokendash-appcast-'));
    const curlStub = join(tempDir, 'curl');
    writeFileSync(curlStub, `#!/bin/bash
url="\${@: -1}"
case "$url" in
  *releases/latest/download/appcast.xml)
    cat <<'XML'
<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel><item><sparkle:version>87</sparkle:version></item></channel>
</rss>
XML
    ;;
  *api.github.com*)
    cat <<'JSON'
[
  {"assets":[{"name":"appcast.xml","browser_download_url":"https://example.com/v1.8.1/appcast.xml"}]}
]
JSON
    ;;
  *v1.8.1*)
    exit 22
    ;;
esac
`, { mode: 0o755 });

    let error: unknown;
    try {
      execFileSync('bash', ['scripts/resolve-sparkle-build-number.sh'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          BUILD_NUMBER: '87',
          CURL_BIN: curlStub,
          GH_BIN: join(tempDir, 'missing-gh'),
          SPARKLE_BUILD_STRICT: '1',
          SPARKLE_APPCAST_URLS: '',
          SPARKLE_FEED_URL: '',
          GITHUB_RELEASES_API_URL: '',
        },
        encoding: 'utf8',
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({ status: 1 });
    expect(String((error as { stderr?: Buffer })?.stderr)).toContain(
      'unable to inspect all recent GitHub Release appcasts'
    );
  });

  it('refuses a release version that does not advance past published versions', () => {
    let error: unknown;
    try {
      execFileSync('bash', ['scripts/assert-release-version-advances.sh', '1.8.2'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          RELEASE_VERSION_REFERENCES: '1.8.2\nv1.8.1\n1.7.5',
        },
        encoding: 'utf8',
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({ status: 1 });
    expect(String((error as { stderr?: Buffer })?.stderr)).toContain(
      'release version 1.8.2 must be greater than latest published 1.8.2'
    );
  });

  it('accepts a release version that advances past published versions', () => {
    expect(() => execFileSync('bash', ['scripts/assert-release-version-advances.sh', '1.8.3'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        RELEASE_VERSION_REFERENCES: '1.8.2\nv1.8.1\n1.7.5',
      },
      encoding: 'utf8',
    })).not.toThrow();
  });

  it('reserves cache bypasses for explicit manual refreshes', () => {
    const apiClient = readFileSync('TokenDashSwift/Sources/TokenDash/Services/APIClient.swift', 'utf8');
    const badgeUpdater = readFileSync('TokenDashSwift/Sources/TokenDash/BadgeUpdater.swift', 'utf8');
    const webRefreshHook = readFileSync('src/client/hooks/useCcusageData.ts', 'utf8');
    expect(apiClient).toContain('"&refresh=1"');
    expect(apiClient).toContain('"/quota\\(refresh ? "?refresh=1" : "")"');
    // Detail endpoints take a `forceRefresh` flag, but automatic refreshes stay
    // cache-aware. Only refreshNow() is allowed to bypass usage and quota caches.
    expect(badgeUpdater).toContain('api.getDaily(agent: agent, refresh: forceRefresh)');
    expect(badgeUpdater).toContain('api.getBlocks(agent: agent, refresh: forceRefresh)');
    expect(badgeUpdater).toContain('api.getProjects(agent: agent, refresh: forceRefresh)');
    expect(badgeUpdater).toContain('api.getQuota(refresh: force)');
    expect(badgeUpdater).toContain('refreshNow()');
    expect(badgeUpdater).toContain('forceRefresh: true, forceQuota: true, recordRefreshTime: true');
    expect(badgeUpdater).not.toContain('performBackgroundRefresh() async {\n        await performFullUpdate(forceRefresh: true');
    expect(webRefreshHook).toContain('setInterval(() => { void fetchData(false); }, intervalMs)');
    expect(webRefreshHook).toContain('const refetch = useCallback(() => fetchData(true)');
    expect(badgeUpdater).toContain('retainUsableQuotas');
    expect(badgeUpdater).toContain('snapshot.freshness != "stale"');
  });
});
