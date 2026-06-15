#!/bin/bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="$REPO_ROOT/TokenDashSwift/.build/release"
DIST_DIR="$REPO_ROOT/dist"
APP_NAME="TokenDash"
APP_BUNDLE="$REPO_ROOT/release/$APP_NAME.app"

echo "==> Packaging $APP_NAME.app..."

# Verify binaries exist
if [ ! -f "$BUILD_DIR/TokenDash" ]; then
    echo "Error: Swift binary not found at $BUILD_DIR/TokenDash"
    echo "Run 'npm run build:swift' first."
    exit 1
fi

if [ ! -d "$DIST_DIR" ]; then
    echo "Error: Node.js dist not found at $DIST_DIR"
    echo "Run 'npm run build' first."
    exit 1
fi

# Remove old bundle
rm -rf "$APP_BUNDLE"

# Create .app bundle structure
APP_MACOS="$APP_BUNDLE/Contents/MacOS"
APP_RESOURCES="$APP_BUNDLE/Contents/Resources"
mkdir -p "$APP_MACOS" "$APP_RESOURCES"

# Copy Swift binary
cp "$BUILD_DIR/TokenDash" "$APP_MACOS/$APP_NAME"
chmod +x "$APP_MACOS/$APP_NAME"

# Copy the application icon used by Finder and macOS permission prompts.
cp "$REPO_ROOT/resources/icon.icns" "$APP_RESOURCES/TokenDash.icns"
# Copy Node.js server dist into Resources/server/
SERVER_DIR="$APP_RESOURCES/server"
mkdir -p "$SERVER_DIR"
cp -R "$DIST_DIR" "$SERVER_DIR/dist"

# Install only the runtime dependencies the daemon needs (express + zod)
# The web client is pre-built in dist/client/ and doesn't need react/recharts at runtime
echo "   Installing minimal runtime dependencies..."
cd "$SERVER_DIR"
npm init -y --silent 2>/dev/null
npm install express zod --production --no-package-lock --silent 2>/dev/null
cd "$REPO_ROOT"

# Copy package.json for version info
cp "$REPO_ROOT/package.json" "$SERVER_DIR/package.json"

# Embed Sparkle.framework (auto-update). SwiftPM links it but doesn't place it
# in the bundle; copy from the checkout with its symlink structure preserved.
APP_FRAMEWORKS="$APP_BUNDLE/Contents/Frameworks"
mkdir -p "$APP_FRAMEWORKS"
SPARKLE_FW=$(find "$REPO_ROOT/TokenDashSwift/.build" -type d -name "Sparkle.framework" -path "*artifacts*" 2>/dev/null | head -1)
if [ -n "$SPARKLE_FW" ] && [ -d "$SPARKLE_FW" ]; then
    cp -R "$SPARKLE_FW" "$APP_FRAMEWORKS/Sparkle.framework"
    if ! otool -l "$APP_MACOS/$APP_NAME" | grep -q '@executable_path/../Frameworks'; then
        install_name_tool -add_rpath '@executable_path/../Frameworks' "$APP_MACOS/$APP_NAME"
    fi
    echo "   Embedded Sparkle.framework"
else
    echo "   ⚠️ Sparkle.framework not found — run 'npm run build:swift' first (needs the Sparkle dep resolved)."
fi

# Resolve version + Sparkle config for Info.plist.
# CFBundleVersion MUST be an incrementing integer (Sparkle compares these).
APP_VERSION=$(node -p "require('$REPO_ROOT/package.json').version" 2>/dev/null || echo "2.0.0")
BUILD_NUMBER="${BUILD_NUMBER:-$(git -C "$REPO_ROOT" rev-list --count HEAD 2>/dev/null || echo "1")}"
SPARKLE_FEED_URL="${SPARKLE_FEED_URL:-https://github.com/zhangferry/tokendash/releases/latest/download/appcast.xml}"
# EdDSA public key: from env, or ~/.tokendash/eddsa_pub.key, or empty (warn).
SPARKLE_EDDSA_PUB="${SPARKLE_EDDSA_PUB:-}"
if [ -z "$SPARKLE_EDDSA_PUB" ] && [ -f ~/.tokendash/eddsa_pub.key ]; then
    SPARKLE_EDDSA_PUB="$(cat ~/.tokendash/eddsa_pub.key)"
fi
if [ -z "$SPARKLE_EDDSA_PUB" ]; then
    echo "   ⚠️ SUPublicEDKey not set. Auto-update will reject updates until you generate keys."
    echo "      Run scripts/sparkle-keys.sh and re-package (see docs/updating.md)."
fi

# Generate Info.plist
cat > "$APP_BUNDLE/Contents/Info.plist" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleDevelopmentRegion</key>
    <string>en</string>
    <key>CFBundleExecutable</key>
    <string>TokenDash</string>
    <key>CFBundleIdentifier</key>
    <string>com.zhangferry-dev.tokendash</string>
    <key>CFBundleName</key>
    <string>TokenDash</string>
    <key>CFBundleDisplayName</key>
    <string>TokenDash</string>
    <key>CFBundleIconFile</key>
    <string>TokenDash.icns</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>$APP_VERSION</string>
    <key>CFBundleVersion</key>
    <string>$BUILD_NUMBER</string>
    <key>LSMinimumSystemVersion</key>
    <string>14.0</string>
    <key>LSUIElement</key>
    <true/>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>NSSupportsAutomaticGraphicsSwitching</key>
    <true/>
    <key>SUFeedURL</key>
    <string>$SPARKLE_FEED_URL</string>
    <key>SUEnableAutomaticChecks</key>
    <true/>
    <key>SUPublicEDKey</key>
    <string>$SPARKLE_EDDSA_PUB</string>
</dict>
</plist>
PLIST

# SwiftPM signs the executable before the app bundle's resources and embedded
# framework exist. Re-sign the completed bundle so LaunchServices accepts it.
# Release builds can provide a Developer ID identity; local builds use ad-hoc.
CODESIGN_IDENTITY="${CODESIGN_IDENTITY:--}"
codesign --force --deep --sign "$CODESIGN_IDENTITY" "$APP_BUNDLE"
echo "   Signed app bundle with identity: $CODESIGN_IDENTITY"

echo "✅ $APP_NAME.app created at $APP_BUNDLE"
echo "   Binary: $(du -sh "$APP_MACOS/$APP_NAME" | cut -f1)"
echo "   Bundle: $(du -sh "$APP_BUNDLE" | cut -f1)"
