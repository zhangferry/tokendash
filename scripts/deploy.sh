#!/bin/bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

DRY_RUN=false
if [ "${1:-}" = "--dry-run" ]; then
    DRY_RUN=true
elif [ "$#" -gt 0 ]; then
    echo "Usage: $0 [--dry-run]"
    exit 1
fi

VERSION=$(node -p "require('./package.json').version")
TAG="v$VERSION"
ARCH=$(uname -m)
DMG="release/TokenDash-$VERSION-$ARCH.dmg"
APPCAST="release/appcast.xml"
REGISTRY="https://registry.npmjs.org"
REPO="zhangferry/tokendash"

fail() {
    echo "Error: $*" >&2
    exit 1
}

step() {
    echo ""
    echo "==> $*"
}

command -v npm >/dev/null || fail "npm is required"
command -v gh >/dev/null || fail "GitHub CLI (gh) is required"
command -v git >/dev/null || fail "git is required"
command -v hdiutil >/dev/null || fail "hdiutil is required"

[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "package.json version is not valid semver: $VERSION"
[ "$(node -p "require('./package-lock.json').version")" = "$VERSION" ] \
    || fail "package-lock.json version does not match package.json"
if [ -z "${SPARKLE_EDDSA_PUB:-}" ] && [ ! -s "$HOME/.tokendash/eddsa_pub.key" ]; then
    fail "Sparkle public key missing. Run ./scripts/sparkle-keys.sh or set SPARKLE_EDDSA_PUB."
fi
if [ -n "${SPARKLE_PRIVATE_KEY_FILE:-}" ] && [ ! -s "$SPARKLE_PRIVATE_KEY_FILE" ]; then
    fail "SPARKLE_PRIVATE_KEY_FILE is not readable: $SPARKLE_PRIVATE_KEY_FILE"
fi
step "Checking release identity and destination"
npm whoami --registry "$REGISTRY" >/dev/null
gh auth status >/dev/null

if npm view "@zhangferry-dev/tokendash@$VERSION" version --registry "$REGISTRY" >/dev/null 2>&1; then
    fail "npm version $VERSION is already published"
fi
if git rev-parse "$TAG" >/dev/null 2>&1; then
    fail "local tag $TAG already exists"
fi
if git ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null 2>&1; then
    fail "remote tag $TAG already exists"
fi
if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
    fail "GitHub Release $TAG already exists"
fi

if ! $DRY_RUN; then
    [ "$(git branch --show-current)" = "main" ] || fail "deploy must run from main"
    [ -z "$(git status --porcelain)" ] || fail "deploy requires a clean working tree"
    git fetch origin main --quiet
    [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] \
        || fail "local main must exactly match origin/main"
fi

step "Running release verification"
npm test
npm run typecheck
npm run test:e2e

step "Building npm package, macOS app, and DMG"
rm -f "$APPCAST"
npm pack --dry-run >/dev/null
npm run build:dmg
[ -s "$DMG" ] || fail "DMG was not created: $DMG"

step "Generating signed Sparkle appcast"
./scripts/sparkle-appcast.sh release/
[ -s "$APPCAST" ] || fail "appcast was not created: $APPCAST"

step "Validating release artifacts"
codesign --verify --deep --strict release/TokenDash.app
hdiutil verify "$DMG" >/dev/null
plutil -lint release/TokenDash.app/Contents/Info.plist >/dev/null

APP_VERSION=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" release/TokenDash.app/Contents/Info.plist)
[ "$APP_VERSION" = "$VERSION" ] || fail "app bundle version is $APP_VERSION, expected $VERSION"

grep -q "releases/download/$TAG/TokenDash-$VERSION-$ARCH.dmg" "$APPCAST" \
    || fail "appcast enclosure does not point to the tagged DMG"
grep -q 'sparkle:edSignature=' "$APPCAST" \
    || fail "appcast DMG enclosure is missing its Sparkle signature"

if $DRY_RUN; then
    step "Deploy check passed for $TAG"
    echo "Artifacts:"
    echo "  $DMG"
    echo "  $APPCAST"
    echo "No npm package, git tag, or GitHub Release was published."
    exit 0
fi

NOTES_FILE=$(mktemp)
cleanup() {
    rm -f "$NOTES_FILE"
}
trap cleanup EXIT

awk -v version="$VERSION" '
    $0 == "### v" version { capture=1; next }
    capture && /^### v/ { exit }
    capture { print }
' CHANGELOG.md > "$NOTES_FILE"
[ -s "$NOTES_FILE" ] || fail "CHANGELOG.md has no notes for $TAG"

step "Creating draft GitHub Release with mandatory update artifacts"
gh release create "$TAG" "$DMG" "$APPCAST" \
    --repo "$REPO" \
    --target "$(git rev-parse HEAD)" \
    --title "TokenDash $TAG" \
    --notes-file "$NOTES_FILE" \
    --draft

step "Publishing npm package"
if ! npm publish --access public --registry "$REGISTRY"; then
    echo "npm publish failed; deleting draft GitHub Release $TAG" >&2
    gh release delete "$TAG" --repo "$REPO" --yes --cleanup-tag >/dev/null 2>&1 || true
    exit 1
fi

step "Publishing git tag and GitHub Release"
git tag -a "$TAG" -m "Release $TAG"
git push origin main
git push origin "$TAG"
gh release edit "$TAG" --repo "$REPO" --draft=false --latest

step "Published $TAG"
echo "npm: https://www.npmjs.com/package/@zhangferry-dev/tokendash/v/$VERSION"
echo "GitHub: https://github.com/$REPO/releases/tag/$TAG"
