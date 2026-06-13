# Auto-updates (Sparkle)

TokenDash uses [Sparkle 2](https://sparkle-project.org) for in-app auto-updates.
Sparkle handles the whole flow: check → download → EdDSA signature verify →
install in place → relaunch. No manual DMG drag-install.

This document covers the **one-time setup** and the **per-release** steps.

## One-time setup

### 1. Build once to resolve the Sparkle dependency

```bash
cd TokenDashSwift && swift build
```

This downloads Sparkle to `.build/checkouts/Sparkle/` and makes its CLI tools
(`generate_keys`, `generate_appcast`) available.

### 2. Generate EdDSA keys

```bash
./scripts/sparkle-keys.sh
```

This:
- Generates an EdDSA keypair.
- Stores the **private key** in your login Keychain (keep it safe — anyone with
  it can ship updates your installed copies accept).
- Writes the **public key** to `~/.tokendash/eddsa_pub.key`.

`scripts/package-app.sh` reads that public key and bakes it into `Info.plist`
as `SUPublicEDKey`, so every packaged build trusts updates signed by your
private key.

### 3. Host the appcast feed

The default `SUFeedURL` is `https://zhangferry.github.io/tokendash/appcast.xml`
(GitHub Pages). Create a `gh-pages` branch (or Pages-enabled repo) and host
`appcast.xml` there. Override the URL at package time with:

```bash
SPARKLE_FEED_URL="https://your-host.example/appcast.xml" npm run build:app
```

## Per-release steps

### 1. Bump the version

Edit `package.json` `version` (e.g. `2.1.0`). `package-app.sh` reads it for
`CFBundleShortVersionString`. The `CFBundleVersion` (build number) is set to the
git commit count automatically, so it increments each release — Sparkle
compares these integers to detect updates.

### 2. Build the package + DMG

```bash
npm run build:app   # builds server + swift + packages .app
npm run build:dmg   # produces release/TokenDash-<ver>-arm64.dmg
```

### 3. Generate the appcast

```bash
./scripts/sparkle-appcast.sh release/
```

This signs the DMG with your Keychain private key and writes `release/appcast.xml`
(+ binary `.delta` files for small updates).

### 4. Publish

Upload to your `SUFeedURL` host:
- `appcast.xml`
- the new `.dmg`
- any `.delta` files

Installed copies poll `SUFeedURL`, find the new entry, verify the EdDSA
signature against `SUPublicEDKey`, download, and install + relaunch
automatically.

## Notes

- `CFBundleVersion` must be an incrementing integer. It's derived from
  `git rev-list --count HEAD`, so each commit that gets packaged bumps it. Don't
  set it manually.
- If `SUPublicEDKey` is empty (keys not generated), `package-app.sh` warns and
  the build runs but installed copies will **reject** updates until a key is set.
- In development (`swift build` + running the bare binary), Sparkle has no app
  bundle / `SUFeedURL`, so it no-ops and logs. Auto-update only matters for the
  packaged `.app`.
