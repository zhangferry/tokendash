# Changelog

### v1.7.4
- **Correct GLM quota windows** — label GLM Coding Plan 5-hour and weekly usage from the provider's explicit window metadata instead of reset-time ordering, so the menu bar app no longer swaps the short-window and weekly percentages.

### v1.7.3
- **Dashboard over IPv4** — open the web dashboard at `127.0.0.1` instead of `localhost` so it always reaches the daemon's IPv4 listener. macOS resolves `localhost` to IPv6 first, so when another local service (e.g. a dev server) owns the same port on IPv6 it would answer `localhost` with "Cannot GET /" and bypass TokenDash entirely.

### v1.7.2
- **Self-healing daemon** — restart the local daemon automatically when it crashes or is reclaimed (up to three startup retries plus a 30s health monitor), so the popover never gets stuck on "Unable to fetch data" until the app is restarted by hand.
- **Hot port switching** — recover the menu bar popover onto the daemon's new port without restarting the app.
- **Dashboard ready gating** — disable the Dashboard button until the daemon is ready so it never opens a dead URL.

### v1.7.1
- **Occupied-port recovery** — bind the native daemon to IPv4 loopback and move to the next available port when another local service already owns `3456`.
- **Safer daemon reuse** — validate TokenDash identity and version before trusting saved state without terminating unrelated processes referenced by stale PID files.
- **Correct macOS app icon** — regenerate every ICNS size from the transparent rounded source while preserving the compact menu bar template icon.
- **Native appearance handling** — use the standard macOS window surface for consistent light, dark, and system-selected themes.
- **Clear unsigned install guidance** — document the one-time quarantine command required for the current ad-hoc-signed macOS release.

### v1.7.0
- **Clear loading badge** — show the TokenDash menu icon with `0K` immediately at launch instead of an ambiguous bare `0`.
- **Release hardening** — finalize the unified npm, DMG, Sparkle appcast, tag, and GitHub Release validation workflow.
- **Responsive native popover** — open the menu bar panel immediately on first launch, with loading placeholders while local usage data initializes.
- **Refined usage controls** — align the model/type selector with usage values and add a smooth product-green animated selection.
- **Polished settings** — initialize launch-at-login before rendering, use stable green switches, and validate coding-plan credentials before saving.
- **Reliable updates and releases** — move the Sparkle feed to GitHub Releases and publish npm, DMG, appcast, tag, and GitHub Release through one deploy command.

### v1.6.2
- **Native macOS menu bar app** — replace the Electron shell with a lightweight SwiftUI app, native settings, launch-at-login support, and Sparkle update handling.
- **Coding plan quota monitoring** — track Claude, Codex, GLM, MiniMax, and Kimi usage windows with reset countdowns and configurable low-quota notifications.
- **Richer menu bar insights** — add seven-day token trends, model usage details, refreshed summaries, and a more focused popover layout.
- **Unified product identity** — refresh the README and align the flat cream-and-green icon across Finder, Applications, notifications, and product imagery.

### v1.6.1
- **CLI and menu bar dashboard sync** — reuse a compatible same-version CLI/npm service from the macOS menu bar app and keep the globally installed package aligned with the DMG version.
- **Update check fallback** — keep the menu bar update checker working after GitHub REST API rate limits by falling back to the public latest-release redirect.

### v1.6.0
- **Popover dashboard redesign** — refreshed the menu bar popover with a more native macOS developer-dashboard layout, compact summary metrics, and project/agent usage tables.
- **Hourly usage chart polish** — aligned Y-axis labels with dashed grid lines, kept peak labels visible, and only shows time labels for hours with usage to reduce chart clutter.
- **Tray popover fit fixes** — tightened vertical spacing so the Projects, Agents, and bottom action bar remain visible inside the fixed menu bar window.

### v1.5.0
- **Project name fix** — correctly display project names with dashes (e.g. `ccusage-dashboard` instead of `dashboard`) using filesystem-based path decoding (#14)
- **Tool call trend fix** — fill missing tool values with 0 so chart lines don't break when a tool has no data for a given day (#13)
- **Unit tests** — added regression tests for project name decoding and tool call trend zero-filling

### v1.4.2
- **Codex usage de-duplication** — avoid double-counting duplicate Codex usage snapshots when parsing session data
- **Codex parser coverage** — added regression tests for duplicate snapshot handling
- **Tray helper compatibility** — keep the native tray helper compatible with macOS 14

### v1.4.1
- **Chart Y-axis improvement** — nice number algorithm for clean axis ticks (round step sizes instead of arbitrary divisions)
- **Bar-tip border removal** — peak value label on the hourly chart no longer has background/border, cleaner look
- **Y-axis alignment fix** — axis labels now properly align with grid lines using flexbox layout
- **Tray icon image rendering** — switched from NSStatusBarButton title to rendered template image for cleaner status bar appearance

### v1.4.0
- **macOS Menu Bar App** — native menu-bar-only application with custom icon, no Dock presence
- **Real-time Status Bar Badge** — live token count in the status bar, updated every 5 seconds with resilient fallback
- **Popover Dashboard** — click the tray icon for today's metrics, hourly chart, agent filter, and settings
- **Native Swift Tray Helper** — lightweight Swift binary for macOS 14+ compatibility
- **Agent Filter** — choose which agents to display in both popover and tray badge, persisted across sessions
- **Popover-to-Tray Sync** — popover renders accurate totals and syncs them back to the status bar badge
- **Dark Mode Support** — automatic theme switching for both popover and tray
- **Port Auto-Fallback** — automatically finds an available port if the default is in use

### v1.3.0
- **Added OpenCode agent support** — parses SQLite database at `~/.local/share/opencode/opencode.db`
- **Added Today by Hour panel** — 24-hour token consumption breakdown for the current day
- **E2E test overhaul** — comprehensive Playwright test suite with fixture-based test data
- **Added CI pipeline** — GitHub Actions for automated testing on push and PR
- **Fixed model trend chart** — included `cacheReadTokens` in model trend calculations

### v1.2.0
- **Replaced `ccusage` CLI** with direct JSONL parser — data loads in 1-2ms instead of 12-30s
- **Added code analytics** — code change trend, tool call trend, daily KPIs
- **Added persistent disk cache** with stale-while-revalidate pattern
- **Fixed heatmap** — cost metric now shows real data (was always $0)
- **Fixed timezone handling** — correct date/hour grouping for non-UTC users
- **Added pricing info popup** — shows per-model pricing formula in Cost mode
- **Added test suite** — 49 unit tests + 6 E2E tests
- **Layout improvements** — model trend bar chart, side-by-side analytics panels
