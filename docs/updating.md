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

### 3. Use GitHub Releases as the appcast feed

The default `SUFeedURL` is:

```text
https://github.com/zhangferry/tokendash/releases/latest/download/appcast.xml
```

Each GitHub Release must contain both its versioned DMG and `appcast.xml`.
GitHub's `latest/download` redirect gives installed apps a stable feed URL
without requiring a separate GitHub Pages site. Override the URL at package
time with:

```bash
SPARKLE_FEED_URL="https://your-host.example/appcast.xml" npm run build:app
```

## Per-release workflow

Version the release in `package.json`, `package-lock.json`, and `CHANGELOG.md`,
then commit the complete release candidate to `main`.

Run the non-publishing verification first:

```bash
npm run deploy:check
```

This runs unit, type, and end-to-end tests; builds the npm package, app, and
versioned DMG; generates the signed `appcast.xml`; and validates the bundle,
DMG, enclosure URL, and Sparkle signature.

Once the release commit is pushed and local `main` exactly matches
`origin/main`, publish everything through the single entry point:

```bash
npm run deploy
```

The deploy command:

1. Repeats all verification and artifact generation.
2. Signs the app and DMG with Developer ID, notarizes the DMG, and staples the ticket.
3. Creates a draft GitHub Release containing both the DMG and `appcast.xml`.
4. Publishes the matching npm version.
5. Pushes the release tag.
6. Publishes the GitHub Release as the latest release.

The command fails before publishing when the npm version, git tag, release, key,
DMG, appcast, or signature is missing or inconsistent. Do not publish npm or
create GitHub Releases manually; that bypasses the checks that keep Sparkle
updates complete.

Local releases use the Sparkle private key in the login Keychain. CI can inject
the same key without importing it by setting `SPARKLE_PRIVATE_KEY_FILE` to a
file containing the base64-encoded EdDSA seed and `SPARKLE_EDDSA_PUB` to the
matching public key.

Distribution also requires:

```bash
export CODESIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)"
export NOTARY_PROFILE="tokendash-notary"
xcrun notarytool store-credentials "$NOTARY_PROFILE"
```

`npm run deploy` refuses to publish an ad-hoc-signed or non-notarized build.
`npm run deploy:check` remains usable for local verification and may produce an
ad-hoc-signed artifact that is not suitable for distribution.

## Notes

- `CFBundleVersion` must be an incrementing integer. It's derived from
  `git rev-list --count HEAD`, so each commit that gets packaged bumps it. Don't
  set it manually.
- If `SUPublicEDKey` is empty (keys not generated), `package-app.sh` warns and
  the build runs but installed copies will **reject** updates until a key is set.
- In development (`swift build` + running the bare binary), Sparkle has no app
  bundle / `SUFeedURL`, so it no-ops and logs. Auto-update only matters for the
  packaged `.app`.
