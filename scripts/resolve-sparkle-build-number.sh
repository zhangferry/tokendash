#!/bin/bash
# Resolve the CFBundleVersion/Sparkle build number for a packaged release.
#
# Sparkle compares the monotonically increasing build number
# (CFBundleVersion / sparkle:version), not just the human-facing semver. A
# shallow checkout or explicit BUILD_NUMBER can accidentally move this number
# backwards, making Sparkle detect a newer shortVersionString but refuse to
# install it. This helper keeps the local build number above recently published
# appcasts while still allowing offline/local builds to fall back to git count.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="${GITHUB_REPO:-zhangferry/tokendash}"
FEED_URL="${SPARKLE_FEED_URL:-https://github.com/${REPO}/releases/latest/download/appcast.xml}"
LOOKBACK="${SPARKLE_RELEASE_LOOKBACK:-10}"
STRICT="${SPARKLE_BUILD_STRICT:-0}"
CURL_BIN="${CURL_BIN:-curl}"
GH_BIN="${GH_BIN:-gh}"

if [ -n "${BUILD_NUMBER:-}" ]; then
    LOCAL_BUILD="$BUILD_NUMBER"
else
    LOCAL_BUILD="$(git -C "$REPO_ROOT" rev-list --count HEAD 2>/dev/null || echo "1")"
fi

if ! [[ "$LOCAL_BUILD" =~ ^[0-9]+$ ]]; then
    echo "Error: BUILD_NUMBER must be an integer, got: $LOCAL_BUILD" >&2
    exit 1
fi

if ! [[ "$LOOKBACK" =~ ^[0-9]+$ ]] || [ "$LOOKBACK" -lt 1 ]; then
    echo "Error: SPARKLE_RELEASE_LOOKBACK must be a positive integer, got: $LOOKBACK" >&2
    exit 1
fi

fetch_url() {
    local url="$1"
    # --retry covers transient CDN drops (a single failed appcast fetch would
    # otherwise abort the whole release build under the strict checks below).
    "$CURL_BIN" -LfsS --retry 3 --retry-delay 1 --retry-all-errors \
        -H "Accept: application/vnd.github+json, application/xml, text/xml;q=0.9, */*;q=0.8" \
        -H "User-Agent: TokenDash-release" \
        "$url"
}

fetch_releases_json() {
    local api_path="repos/${REPO}/releases?per_page=${LOOKBACK}"
    local api_url="${GITHUB_RELEASES_API_URL:-https://api.github.com/${api_path}}"

    if [ -z "${GITHUB_RELEASES_API_URL:-}" ] \
        && command -v "$GH_BIN" >/dev/null 2>&1 \
        && "$GH_BIN" auth status >/dev/null 2>&1; then
        "$GH_BIN" api "$api_path"
        return
    fi

    fetch_url "$api_url"
}

extract_versions() {
    node -e '''
const fs = require("node:fs");
const input = fs.readFileSync(0, "utf8");
const versions = [];
for (const match of input.matchAll(/<(?:[A-Za-z0-9_-]+:)?version\b[^>]*>\s*(\d+)\s*<\/(?:[A-Za-z0-9_-]+:)?version>/g)) {
  versions.push(match[1]);
}
process.stdout.write(versions.join("\n") + (versions.length ? "\n" : ""));
'''
}
extract_appcast_urls() {
    node -e '''
const fs = require("node:fs");
let releases;
try {
  releases = JSON.parse(fs.readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}
if (!Array.isArray(releases)) process.exit(0);
const urls = [];
for (const release of releases) {
  for (const asset of release.assets || []) {
    if (asset && asset.name === "appcast.xml" && asset.browser_download_url) {
      urls.push(asset.browser_download_url);
    }
  }
}
const uniqueUrls = [...new Set(urls)];
process.stdout.write(uniqueUrls.join("\n") + (uniqueUrls.length ? "\n" : ""));
'''
}
REMOTE_VERSIONS=()
FETCHED_ANY=0
FETCHED_RECENT_RELEASES=0
RECENT_APPCAST_URL_COUNT=0
RECENT_APPCAST_SUCCESS_COUNT=0
RECENT_APPCAST_FAILURE_COUNT=0

add_versions_from_url() {
    local url="$1"
    local xml versions
    if ! xml="$(fetch_url "$url" 2>/dev/null)"; then
        echo "Warning: unable to fetch Sparkle appcast: $url" >&2
        return 1
    fi
    versions="$(printf '%s' "$xml" | extract_versions || true)"
    if [ -z "$versions" ]; then
        echo "Warning: Sparkle appcast has no sparkle:version values: $url" >&2
        return 1
    fi
    FETCHED_ANY=1
    while IFS= read -r version; do
        [ -n "$version" ] && REMOTE_VERSIONS+=("$version")
    done <<< "$versions"
}

add_recent_versions_from_url() {
    local url="$1"
    RECENT_APPCAST_URL_COUNT=$((RECENT_APPCAST_URL_COUNT + 1))
    if add_versions_from_url "$url"; then
        RECENT_APPCAST_SUCCESS_COUNT=$((RECENT_APPCAST_SUCCESS_COUNT + 1))
    else
        RECENT_APPCAST_FAILURE_COUNT=$((RECENT_APPCAST_FAILURE_COUNT + 1))
    fi
}

# Always inspect the configured feed first. In production this is GitHub's
# releases/latest appcast; in tests it can be a controlled fixture URL.
add_versions_from_url "$FEED_URL" || true

# Inspect recent release appcasts too, not just releases/latest. This catches a
# bad latest appcast whose build number already regressed below the prior
# release (for example 1.8.2 build 87 after 1.8.1 build 106).
if [ -n "${SPARKLE_APPCAST_URLS:-}" ]; then
    FETCHED_RECENT_RELEASES=1
    while IFS= read -r url; do
        [ -n "$url" ] && add_recent_versions_from_url "$url"
    done <<< "$SPARKLE_APPCAST_URLS"
else
    if releases_json="$(fetch_releases_json 2>/dev/null)"; then
        FETCHED_RECENT_RELEASES=1
        urls="$(printf '%s' "$releases_json" | extract_appcast_urls || true)"
        while IFS= read -r url; do
            [ -n "$url" ] && add_recent_versions_from_url "$url"
        done <<< "$urls"
        if [ "$RECENT_APPCAST_URL_COUNT" -eq 0 ]; then
            echo "Warning: recent GitHub Releases did not include appcast.xml assets for $REPO" >&2
        fi
    else
        echo "Warning: unable to fetch recent GitHub Releases for $REPO" >&2
    fi
fi

if [ "$STRICT" = "1" ]; then
    if [ "$FETCHED_ANY" -ne 1 ]; then
        echo "Error: unable to fetch any published Sparkle appcast; refusing release build." >&2
        exit 1
    fi
    if [ "$FETCHED_RECENT_RELEASES" -ne 1 ]; then
        echo "Error: unable to inspect recent GitHub Release appcasts; refusing release build." >&2
        exit 1
    fi
    if [ "$RECENT_APPCAST_URL_COUNT" -eq 0 ]; then
        echo "Error: no recent GitHub Release appcasts were available to inspect; refusing release build." >&2
        exit 1
    fi
    if [ "$RECENT_APPCAST_FAILURE_COUNT" -ne 0 ]; then
        echo "Error: unable to inspect all recent GitHub Release appcasts; refusing release build." >&2
        exit 1
    fi
fi

MAX_REMOTE=0
for version in ${REMOTE_VERSIONS[@]+"${REMOTE_VERSIONS[@]}"}; do
    if [[ "$version" =~ ^[0-9]+$ ]] && [ "$version" -gt "$MAX_REMOTE" ]; then
        MAX_REMOTE="$version"
    fi
done

MIN_NEXT=$((MAX_REMOTE + 1))
if [ "$LOCAL_BUILD" -lt "$MIN_NEXT" ]; then
    echo "Info: raising Sparkle build number from $LOCAL_BUILD to $MIN_NEXT (latest published max: $MAX_REMOTE)." >&2
    echo "$MIN_NEXT"
else
    echo "$LOCAL_BUILD"
fi
