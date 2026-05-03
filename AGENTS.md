# AGENTS.md

This file provides guidance to AI coding agents (Claude Code, Codex, etc.) when working with code in this repository.

## Commands

```bash
npm run dev          # Start both server (tsx watch) and client (vite) concurrently
npm run build        # Build frontend (vite build) + server (tsc)
npm run typecheck    # Type-check both server and frontend without emitting
npm test             # Run unit tests (vitest)
npm run test:e2e     # Run e2e tests (playwright)
npm run start        # Run production build
```

Run a single unit test: `npx vitest run src/path/to.test.ts`
Run a single e2e test: `npx playwright test -g "test name pattern"`

## Architecture

Three-tier app: **Express server** parses local AI assistant data files and serves JSON APIs; **React frontend** (Vite + Tailwind + Recharts) renders dashboards; **shared types** connect them.

### Multi-Agent Parser Pattern

Each supported AI coding assistant has a parser module in `src/server/`:

| Agent | Parser | Data Source | Analytics |
|---|---|---|---|
| Claude Code | `claudeJsonlParser.ts` + `claudeBlocksParser.ts` | `~/.claude/projects/` JSONL | Yes |
| Codex | `codexParser.ts` | `~/.codex/sessions/` | No |
| OpenClaw | `openclawParser.ts` | `~/.openclaw/sessions/` | Yes |
| OpenCode | `opencodeParser.ts` | `~/.local/share/opencode/opencode.db` (SQLite) | No |

Every parser exports the same interface: `getDailyResponse()`, `getProjectsResponse()`, `getBlocksResponse()`. Detection functions live in `agentDetection.ts`.

Adding a new agent requires: parser module → detection function → route dispatch in `daily.ts`/`projects.ts`/`blocks.ts`/`analytics.ts` → agent button in `Dashboard.tsx`.

### API Routes

All endpoints in `src/server/routes/` follow the same pattern: check cache → stale-while-revalidate → parse → validate with Zod schema (`src/shared/schemas.ts`) → respond.

### Frontend Data Flow

`Dashboard.tsx` fetches 4 endpoints (`daily`, `projects`, `blocks`, `analytics`) via `useCcusageData` hook. `filteredDaily` prefers `projectsData` (per-model breakdowns) over `dailyData` (aggregated totals). Time range and project filtering happen client-side via `filterProjectDaily()` and `filterByTime()`.

## E2E Testing Strategy

E2E tests use `page.route()` to intercept all `/api/*` calls and return deterministic fixture data from `e2e/fixtures.ts`. Dates are generated relative to `Date.now()` so "Today" tests always work. No real data files needed — tests run on any machine or CI.

Playwright config uses `vite preview` (port 3457) to serve the built frontend, with `CI=true` preventing server reuse.

## Stability Rules

- **Bug fix / small change**: must pass `npm test` (unit tests) before committing
- **Larger change** (new agent, route logic, Dashboard rendering): must pass `npm run test:e2e` (e2e tests) before committing
- **PR submission**: CI runs both `npm test` and `npm run test:e2e` automatically
