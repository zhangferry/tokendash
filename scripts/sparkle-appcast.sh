#!/bin/bash
# Generate the Sparkle appcast.xml (+ delta files) for a release.
#
# Point this at a folder containing the release .dmg(s). It reads the EdDSA
# private key from your Keychain (created by sparkle-keys.sh), signs the
# archives, and emits appcast.xml — the RSS feed Sparkle polls for updates.
#
# Upload appcast.xml alongside the DMG in the matching GitHub Release.
set -euo pipefail

if [ "$#" -lt 1 ]; then
    echo "Usage: $0 <releases-folder-containing-dmgs>"
    echo "Example: $0 release/"
    exit 1
fi

RELEASES_DIR="$1"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SPARKLE_BIN="$REPO_ROOT/TokenDashSwift/.build/artifacts/sparkle/Sparkle/bin"
GEN_APPCAST="$SPARKLE_BIN/generate_appcast"
APP_VERSION=$(node -p "require('$REPO_ROOT/package.json').version")
ARCH=$(uname -m)
DMG_NAME="TokenDash-$APP_VERSION-$ARCH.dmg"
DMG_PATH="$RELEASES_DIR/$DMG_NAME"
TAG="v$APP_VERSION"
DOWNLOAD_PREFIX="https://github.com/zhangferry/tokendash/releases/download/$TAG/"
SPARKLE_KEY_ACCOUNT="${SPARKLE_KEY_ACCOUNT:-ed25519}"

if [ ! -x "$GEN_APPCAST" ]; then
    echo "Error: Sparkle generate_appcast not found at $SPARKLE_BIN"
    echo "Run 'cd TokenDashSwift && swift build' once to resolve the Sparkle dependency."
    exit 1
fi

if [ ! -d "$RELEASES_DIR" ]; then
    echo "Error: releases folder not found: $RELEASES_DIR"
    exit 1
fi

if [ ! -f "$DMG_PATH" ]; then
    echo "Error: release DMG not found: $DMG_PATH"
    echo "Expected the versioned artifact for package.json version $APP_VERSION."
    exit 1
fi

# Build a one-item feed in isolation. This keeps releases/latest stable while
# ensuring the enclosure URL always points at the tag that owns this DMG.
STAGING_DIR=$(mktemp -d)
trap 'rm -rf "$STAGING_DIR"' EXIT
cp "$DMG_PATH" "$STAGING_DIR/$DMG_NAME"

echo "==> Generating appcast.xml for $TAG ..."
APPCAST_ARGS=(
    --download-url-prefix "$DOWNLOAD_PREFIX"
    --link "https://github.com/zhangferry/tokendash/releases/tag/$TAG"
)
if [ -n "${SPARKLE_PRIVATE_KEY_FILE:-}" ]; then
    [ -s "$SPARKLE_PRIVATE_KEY_FILE" ] || {
        echo "Error: SPARKLE_PRIVATE_KEY_FILE is not readable: $SPARKLE_PRIVATE_KEY_FILE"
        exit 1
    }
    APPCAST_ARGS+=(--ed-key-file "$SPARKLE_PRIVATE_KEY_FILE")
else
    APPCAST_ARGS+=(--account "$SPARKLE_KEY_ACCOUNT")
fi
"$GEN_APPCAST" "${APPCAST_ARGS[@]}" "$STAGING_DIR"
cp "$STAGING_DIR/appcast.xml" "$RELEASES_DIR/appcast.xml"

echo ""
echo "✅ Generated: $RELEASES_DIR/appcast.xml"
echo "   Upload $DMG_NAME and appcast.xml to GitHub Release $TAG."
echo "   Feed URL: https://github.com/zhangferry/tokendash/releases/latest/download/appcast.xml"
