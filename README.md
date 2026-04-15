# tokendash

A beautiful, local web dashboard for visualizing your Claude Code, Codex, and OpenClaw token usage statistics.

It runs locally and parses token usage data directly from local session files, presenting it in a clean, interactive React dashboard. Claude Code partially relies on the `ccusage` CLI for some data.

![Product Screenshoot](resources/product_screenshoot.png)

## Features

- **Multi-Agent Support:** View usage for both Claude Code and Codex.
- **Detailed Metrics:** Track total tokens, cost (USD), active days, and cache hit rates.
- **Interactive Charts:** Visualize usage trends over time with tooltips and breakdowns.
- **Model Distribution:** See which models are driving your usage.
- **Project Analysis:** (For Claude Code) Understand which projects consume the most tokens.
- **Persistent Filters:** Your selected time range, project, and metric mode are saved automatically.

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
- **Data Source:** Codex and OpenClaw data is parsed directly from local session files. Claude Code data partially uses `ccusage --json` CLI. Uses a short-lived in-memory cache to ensure snappy UI updates when toggling filters.

## License

[MIT](./LICENSE)
