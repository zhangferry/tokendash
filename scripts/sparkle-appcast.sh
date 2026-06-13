#!/bin/bash
# Generate the Sparkle appcast.xml (+ delta files) for a release.
#
# Point this at a folder containing the release .dmg(s). It reads the EdDSA
# private key from your Keychain (created by sparkle-keys.sh), signs the
# archives, and emits appcast.xml — the RSS feed Sparkle polls for updates.
#
# Upload appcast.xml + the DMG + *.delta to your SUFeedURL host (GitHub Pages).
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

if [ ! -x "$GEN_APPCAST" ]; then
    echo "Error: Sparkle generate_appcast not found at $SPARKLE_BIN"
    echo "Run 'cd TokenDashSwift && swift build' once to resolve the Sparkle dependency."
    exit 1
fi

if [ ! -d "$RELEASES_DIR" ]; then
    echo "Error: releases folder not found: $RELEASES_DIR"
    exit 1
fi

echo "==> Generating appcast.xml from $RELEASES_DIR ..."
"$GEN_APPCAST" "$RELEASES_DIR"

echo ""
echo "✅ Generated: appcast.xml (+ *.delta) in $RELEASES_DIR"
echo "   Upload these to your SUFeedURL host."
echo "   Default SUFeedURL: https://zhangferry.github.io/tokendash/appcast.xml"
