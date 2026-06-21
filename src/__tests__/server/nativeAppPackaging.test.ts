import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

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

  it('forces native menu bar refreshes past server-side caches', () => {
    const apiClient = readFileSync('TokenDashSwift/Sources/TokenDash/Services/APIClient.swift', 'utf8');
    const badgeUpdater = readFileSync('TokenDashSwift/Sources/TokenDash/BadgeUpdater.swift', 'utf8');
    expect(apiClient).toContain('"&refresh=1"');
    expect(apiClient).toContain('"/quota\\(refresh ? "?refresh=1" : "")"');
    expect(badgeUpdater).toContain('api.getDaily(agent: agent, refresh: true)');
    expect(badgeUpdater).toContain('api.getBlocks(agent: agent, refresh: true)');
    expect(badgeUpdater).toContain('api.getProjects(agent: agent, refresh: true)');
    expect(badgeUpdater).toContain('api.getQuota(refresh: true)');
    expect(badgeUpdater).toContain('retainUsableQuotas');
    expect(badgeUpdater).toContain('snapshot.freshness != "stale"');
  });
});
