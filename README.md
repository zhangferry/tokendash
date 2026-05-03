# tokendash

A beautiful, local web dashboard for visualizing your Claude Code, Codex, OpenClaw, and OpenCode token usage statistics.

It runs locally and parses token usage data directly from local session files, presenting it in a clean, interactive React dashboard. No external CLI dependencies required.

![Product Screenshoot](resources/product_screenshoot.png)

## Features

- **Multi-Agent Support:** View usage for Claude Code, Codex, OpenClaw, and OpenCode.
- **Direct JSONL Parsing:** Reads `~/.claude/projects/` JSONL files directly — no `ccusage` CLI dependency, 100x faster data loading.
- **Detailed Metrics:** Track total tokens, cost (USD), active days, cache hit rates, and output/input ratio.
- **Today by Hour:** 24-hour token consumption panel showing hourly breakdown for the current day.
- **Code Analytics:** Visualize code change trends, tool call frequency, and productivity KPIs (Claude Code & OpenClaw only).
- **Pricing Transparency:** Toggle Cost metric to see per-model pricing formula and rates.
- **Interactive Charts:** Bar/line/area charts with tooltips, model breakdowns, and time range filtering.
- **24-Hour Heatmap:** Activity distribution by hour and day of week, with timezone awareness.
- **Model & Project Distribution:** See which models and projects drive your usage.
- **Persistent Filters:** Your selected time range, project, and metric mode are saved automatically.
- **Test Coverage:** Unit tests (Vitest) and E2E tests (Playwright) for reliability.

## Requirements

- Node.js 20 or later
- npm or another Node package manager

## Installation & Usage

You can run the dashboard directly using `npx` without installing it globally:

```bash
npx @zhangferry-dev/tokendash
```

Or install it globally:

```bash
npm install -g @zhangferry-dev/tokendash
tokendash
```

By default, the backend server runs on port `3456`. When running the production build or installing globally, you access the dashboard at `http://localhost:3456`.

During development (`npm run dev`), Vite starts a separate development server on port `5173` with hot-module replacement. You should access the dashboard at `http://localhost:5173` while developing.

### Command Line Options

```bash
tokendash [options]

Options:
  --port <number>    Port to run the server on (default: 3456 or PORT env var)
  --no-open          Do not automatically open the browser
```

## Development

If you want to contribute or modify the dashboard locally:

1. Clone the repository:
   ```bash
   git clone <repository-url>
   cd tokendash
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Start the development servers (runs Vite for frontend and tsx for backend concurrently):
   ```bash
   npm run dev
   ```

4. Build for production:
   ```bash
   npm run build
   ```

5. Run the production build locally:
   ```bash
   npm start
   ```

## Architecture

- **Frontend:** React 19, Recharts, Tailwind CSS (via Vite plugin), built with Vite.
- **Backend:** Express, TypeScript.
- **Data Source:** All agent data is parsed directly from local session files (`~/.claude/projects/`, `~/.codex/sessions/`) and OpenCode's SQLite database (`~/.local/share/opencode/opencode.db`). No external CLI dependencies.
- **Caching:** Persistent disk cache (`/tmp/tokendash-cache/`) with stale-while-revalidate pattern for snappy UI updates.
- **Testing:** Vitest (unit), Playwright (E2E). Run with `npm test` and `npm run test:e2e`.
- **CI:** GitHub Actions pipeline for automated testing on every push and PR.

## Changelog

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

## License

[MIT](./LICENSE)
