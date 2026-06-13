#!/bin/bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_BUNDLE="$REPO_ROOT/release/TokenDash.app"
DMG_PATH="$REPO_ROOT/release/TokenDash.dmg"

if [ ! -d "$APP_BUNDLE" ]; then
    echo "Error: TokenDash.app not found. Run ./scripts/package-app.sh first."
    exit 1
fi

echo "==> Creating DMG..."

# Remove old DMG
rm -f "$DMG_PATH"

# Create DMG
hdiutil create \
    -volname "TokenDash" \
    -srcfolder "$APP_BUNDLE" \
    -ov \
    -format UDZO \
    "$DMG_PATH"

echo "✅ DMG created at $DMG_PATH"
echo "   Size: $(du -sh "$DMG_PATH" | cut -f1)"
