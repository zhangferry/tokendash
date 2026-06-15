#!/bin/bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE_ICON="$REPO_ROOT/resources/icon.png"
OUTPUT_ICON="$REPO_ROOT/resources/icon.icns"
OUTPUT_1024="$REPO_ROOT/resources/icon-1024.png"
ICONSET_DIR=$(mktemp -d)/TokenDash.iconset

cleanup() {
    rm -rf "$(dirname "$ICONSET_DIR")"
}
trap cleanup EXIT

[ -f "$SOURCE_ICON" ] || {
    echo "Error: source icon not found: $SOURCE_ICON" >&2
    exit 1
}

mkdir -p "$ICONSET_DIR"

render() {
    local pixels="$1"
    local name="$2"
    sips -z "$pixels" "$pixels" "$SOURCE_ICON" --out "$ICONSET_DIR/$name" >/dev/null
}

render 16 icon_16x16.png
render 32 icon_16x16@2x.png
render 32 icon_32x32.png
render 64 icon_32x32@2x.png
render 128 icon_128x128.png
render 256 icon_128x128@2x.png
render 256 icon_256x256.png
render 512 icon_256x256@2x.png
render 512 icon_512x512.png
render 1024 icon_512x512@2x.png

cp "$ICONSET_DIR/icon_512x512@2x.png" "$OUTPUT_1024"
iconutil -c icns "$ICONSET_DIR" -o "$OUTPUT_ICON"

echo "Generated:"
echo "  $OUTPUT_1024"
echo "  $OUTPUT_ICON"
