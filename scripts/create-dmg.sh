#!/bin/bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_BUNDLE="$REPO_ROOT/release/TokenDash.app"
APP_VERSION=$(node -p "require('$REPO_ROOT/package.json').version")
ARCH=$(uname -m)
DMG_PATH="$REPO_ROOT/release/TokenDash-$APP_VERSION-$ARCH.dmg"
STAGING_DIR="$REPO_ROOT/release/.dmg-staging"
RW_DMG_PATH="$REPO_ROOT/release/.tokendash-rw.dmg"

if [ ! -d "$APP_BUNDLE" ]; then
    echo "Error: TokenDash.app not found. Run ./scripts/package-app.sh first."
    exit 1
fi

echo "==> Creating DMG..."

# Build a standard drag-to-install disk image. Finder displays the app next to
# an Applications alias so users can drag TokenDash.app directly into it.
rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR"
cp -R "$APP_BUNDLE" "$STAGING_DIR/TokenDash.app"
ln -s /Applications "$STAGING_DIR/Applications"
mkdir -p "$STAGING_DIR/.background"
swift "$REPO_ROOT/scripts/generate-dmg-background.swift" \
    "$STAGING_DIR/.background/background.png"

cleanup() {
    rm -rf "$STAGING_DIR"
    rm -f "$RW_DMG_PATH"
}
trap cleanup EXIT

# Remove old DMG and any interrupted writable image.
rm -f "$DMG_PATH" "$RW_DMG_PATH"

# Create a writable DMG first so Finder can persist the window layout.
hdiutil create \
    -volname "TokenDash" \
    -srcfolder "$STAGING_DIR" \
    -ov \
    -format UDRW \
    "$RW_DMG_PATH"

# Persist a Finder layout with a visible background instruction. This is best
# effort so the DMG remains buildable in headless release environments.
MOUNT_POINT=""
DEVICE=""
detach_dmg() {
    local mounted_device="$DEVICE"
    if [ -z "$mounted_device" ] && [ -n "$MOUNT_POINT" ]; then
        mounted_device=$(mount | awk -v mount="$MOUNT_POINT" '$0 ~ mount {print $1; exit}')
    fi
    if [ -n "$mounted_device" ]; then
        hdiutil detach "$mounted_device" >/dev/null 2>&1 || true
    fi
}
trap 'detach_dmg; cleanup' EXIT

if ATTACH_OUTPUT=$(hdiutil attach -readwrite "$RW_DMG_PATH"); then
    DEVICE=$(printf '%s\n' "$ATTACH_OUTPUT" | awk '$0 ~ /\/Volumes\// {print $1; exit}')
    MOUNT_POINT=$(printf '%s\n' "$ATTACH_OUTPUT" | awk '$0 ~ /\/Volumes\// {print $NF; exit}')
fi

if [ -n "$DEVICE" ] && [ -n "$MOUNT_POINT" ]; then
    if ! SCRIPT_OUTPUT=$(osascript - "$MOUNT_POINT" 2>&1 <<'APPLESCRIPT'
on run argv
    set mountPath to item 1 of argv
    set backgroundFile to POSIX file (mountPath & "/.background/background.png")
    set dmgFolder to POSIX file mountPath as alias
    tell application "Finder"
        open dmgFolder
        delay 1
        set dmgWindow to front window
        set current view of dmgWindow to icon view
        set toolbar visible of dmgWindow to false
        set statusbar visible of dmgWindow to false
        set bounds of dmgWindow to {120, 120, 1000, 550}
        set iconView to icon view options of dmgWindow
        set arrangement of iconView to not arranged
        set icon size of iconView to 128
        set text size of iconView to 16
        set background picture of iconView to backgroundFile
        set position of item "TokenDash.app" of dmgFolder to {262, 250}
        set position of item "Applications" of dmgFolder to {618, 250}
        update dmgFolder without registering applications
        delay 1
        close dmgWindow
    end tell
end run
APPLESCRIPT
    ); then
        printf '%s\n' "$SCRIPT_OUTPUT"
        echo "   ⚠️ Finder layout could not be customized; using default DMG view"
    else
        echo "   Configured Finder drag-to-Applications layout"
    fi
    hdiutil detach "$DEVICE" >/dev/null
    DEVICE=""
else
    echo "   ⚠️ DMG could not be mounted for Finder layout; using default DMG view"
    detach_dmg
fi

# Compress the configured writable image for distribution.
hdiutil convert "$RW_DMG_PATH" -format UDZO -ov -o "$DMG_PATH" >/dev/null
rm -f "$RW_DMG_PATH"

if [ -n "${CODESIGN_IDENTITY:-}" ] && [ "$CODESIGN_IDENTITY" != "-" ]; then
    codesign --force --timestamp --sign "$CODESIGN_IDENTITY" "$DMG_PATH"
    echo "   Signed DMG with identity: $CODESIGN_IDENTITY"
fi

echo "✅ DMG created at $DMG_PATH"
echo "   Size: $(du -sh "$DMG_PATH" | cut -f1)"
