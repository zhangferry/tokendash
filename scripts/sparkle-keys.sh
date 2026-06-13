#!/bin/bash
# Generate or export Sparkle EdDSA keys for signing auto-updates.
#
# Sparkle's `generate_keys` stores the PRIVATE key in your login Keychain and
# prints the PUBLIC key. We save the public key to ~/.tokendash/eddsa_pub.key so
# scripts/package-app.sh bakes it into Info.plist as SUPublicEDKey.
#
# Keep the private key safe (it's in your Keychain) — anyone with it can ship
# updates that your installed copies will accept.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SPARKLE_BIN="$REPO_ROOT/TokenDashSwift/.build/artifacts/sparkle/Sparkle/bin"

GEN_KEYS="$SPARKLE_BIN/generate_keys"

if [ ! -x "$GEN_KEYS" ]; then
    echo "Error: Sparkle tools not found at $SPARKLE_BIN"
    echo "Run 'cd TokenDashSwift && swift build' once to resolve the Sparkle dependency."
    exit 1
fi

echo "==> Generating EdDSA keypair (private key stored in login Keychain)..."
"$GEN_KEYS"

PUB_OUT="$HOME/.tokendash/eddsa_pub.key"
mkdir -p "$(dirname "$PUB_OUT")"
# -p looks up the existing key and prints just the public key.
"$GEN_KEYS" -p > "$PUB_OUT"
chmod 600 "$PUB_OUT"

echo ""
echo "✅ Public key written to $PUB_OUT"
echo "   package-app.sh will embed it as SUPublicEDKey automatically."
echo ""
echo "Public key (for reference):"
cat "$PUB_OUT"
