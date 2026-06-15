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

  it('requires signed and notarized artifacts for publishing', () => {
    const packageApp = readFileSync('scripts/package-app.sh', 'utf8');
    const deploy = readFileSync('scripts/deploy.sh', 'utf8');
    expect(packageApp).toContain('RELEASE_BUILD requires CODESIGN_IDENTITY');
    expect(deploy).toContain('xcrun notarytool submit');
    expect(deploy).toContain('xcrun stapler staple');
    expect(deploy).toContain('Developer ID Application:');
  });
});
