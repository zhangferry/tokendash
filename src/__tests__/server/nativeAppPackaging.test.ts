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

  it('uses one adaptive background token for the native popover and header', () => {
    const helpers = readFileSync('TokenDashSwift/Sources/TokenDash/Helpers.swift', 'utf8');
    expect(helpers).toContain('static let popoverBackground: Color = nativePopoverSurface');
    expect(helpers).toContain('static let headerBackground: Color = nativePopoverSurface');
    expect(helpers).toContain('static let nativePopoverSurface');
    expect(helpers).toContain('case .light:');
    expect(helpers).toContain('return NSColor.white');
    expect(helpers).toContain('case .dark:');
    expect(helpers).toContain('return NSColor.windowBackgroundColor');
    expect(helpers).not.toContain('.controlBackgroundColor');
  });

  it('cleans stale or incompatible daemon state during native app upgrades', () => {
    const daemonManager = readFileSync('TokenDashSwift/Sources/TokenDash/DaemonManager.swift', 'utf8');
    expect(daemonManager).toContain('cleanupIncompatibleDaemon');
    expect(daemonManager).toContain('stopDaemonProcess(pid:');
    expect(daemonManager).toContain('await isCompatibleDaemon(port: existingPort)');
  });
});
