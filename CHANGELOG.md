# Changelog

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
