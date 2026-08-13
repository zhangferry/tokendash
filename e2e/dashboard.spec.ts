import { test, expect } from '@playwright/test';
import { generateDailyResponse, generateSessionDetail, mockApiRoutes } from './fixtures.js';
import { formatTokens } from '../src/client/utils/formatters.js';

// ---------------------------------------------------------------------------
// Helper: set up mocked page and wait for initial load
// ---------------------------------------------------------------------------

async function setupPage(page: import('@playwright/test').Page, options?: { agents?: string[] }) {
  await mockApiRoutes(page, { agents: options?.agents });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('text=Total tokens', { timeout: 15000 });
}

async function selectAgent(page: import('@playwright/test').Page, label: string) {
  await page.locator('button[aria-haspopup="menu"]').click();
  await page.getByRole('menuitemradio', { name: label }).click();
}

// ---------------------------------------------------------------------------
// KPI Cards — all agents
// ---------------------------------------------------------------------------

test.describe('KPI cards', () => {
  const agents: Array<{ name: string; label: string }> = [
    { name: 'claude', label: 'Claude Code' },
    { name: 'opencode', label: 'OpenCode' },
    { name: 'codex', label: 'Codex' },
  ];

  for (const { name, label } of agents) {
    test(`${label}: shows all 5 KPI cards`, async ({ page }) => {
      await mockApiRoutes(page, { agents: [name] });
      await page.goto('/', { waitUntil: 'domcontentloaded' });

      // Click the agent button if available
      const btn = page.locator(`button:has-text("${label}")`);
      if (await btn.isVisible().catch(() => false)) {
        await btn.click();
      }

      await page.waitForSelector('text=Total tokens', { timeout: 15000 });

      await expect(page.locator('span:text-is("Total tokens")')).toBeVisible();
      await expect(page.locator('span:text-is("Daily avg")')).toBeVisible();
      await expect(page.locator('span:text-is("Cache hit")')).toBeVisible();
      await expect(page.locator('span:text-is("Output/Input")')).toBeVisible();
    });
  }
});

// ---------------------------------------------------------------------------
// Agent-specific tests
// ---------------------------------------------------------------------------

test.describe('Agent: Claude Code', () => {
  test.beforeEach(async ({ page }) => {
    await setupPage(page, { agents: ['claude', 'opencode'] });
  });

  test('shows Claude Code as active agent', async ({ page }) => {
    const claudeBtn = page.locator('button:has-text("Claude Code")');
    await expect(claudeBtn).toBeVisible();
    const classes = await claudeBtn.getAttribute('class') || '';
    expect(classes).toContain('bg-white');
  });

  test('shows analytics section (Code Change Trend)', async ({ page }) => {
    // The AnalyticsSection renders "Code Change Trend" panel for Claude
    await expect(page.locator('text=Code Change Trend')).toBeVisible({ timeout: 5000 });
  });

  test('model trend chart shows claude models', async ({ page }) => {
    await expect(page.locator('text=Model trend')).toBeVisible();
    // shortModelName("claude-sonnet-4-5") → "Sonnet 4", "claude-opus-4-5" → "Opus 4"
    const legend = page.locator('li:has-text("Sonnet")');
    await expect(legend.first()).toBeVisible({ timeout: 5000 });
  });
});

test.describe('Agent: OpenCode', () => {
  test.beforeEach(async ({ page }) => {
    await setupPage(page, { agents: ['claude', 'opencode'] });
    await selectAgent(page, 'OpenCode');
    await page.waitForTimeout(2000);
  });

  test('shows OpenCode as active agent', async ({ page }) => {
    await expect(page.locator('button[aria-haspopup="menu"]')).toContainText('OpenCode');
  });

  test('hides analytics section', async ({ page }) => {
    await expect(page.locator('text=Code Change Trend')).not.toBeVisible();
  });

  test('model trend chart shows opencode models', async ({ page }) => {
    await expect(page.locator('text=Model trend')).toBeVisible();
    // glm-4.7 stays as "glm-4.7" (no shortName mapping)
    await expect(page.locator('li:has-text("glm")').first()).toBeVisible({ timeout: 5000 });
  });

  test('project select shows projects', async ({ page }) => {
    const select = page.locator('select');
    await expect(select).toBeVisible();
    // Check option count (options are always in DOM even if hidden in dropdown)
    const optCount = await select.locator('option').count();
    expect(optCount).toBeGreaterThan(1);
  });

  test('heatmap renders with data', async ({ page }) => {
    const heatmap = page.locator('text=24-Hour Activity Heatmap');
    await expect(heatmap).toBeVisible();

    const coloredCells = page.locator('[style*="rgba(16, 185, 129"]');
    const count = await coloredCells.count();
    expect(count).toBeGreaterThan(0);
  });

  test('daily detail table shows entries', async ({ page }) => {
    await expect(page.locator('text=Daily detail')).toBeVisible();
    const rows = page.locator('table tbody tr');
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);
  });
});

test.describe('Agent: Codex', () => {
  test.beforeEach(async ({ page }) => {
    await setupPage(page, { agents: ['claude', 'codex'] });
    await selectAgent(page, 'Codex');
    await page.waitForTimeout(2000);
  });

  test('hides analytics section', async ({ page }) => {
    await expect(page.locator('text=Code Change Trend')).not.toBeVisible();
  });

  test('shows KPI data', async ({ page }) => {
    await expect(page.locator('span:text-is("Total tokens")')).toBeVisible();
  });

  test('labels process-inferred Skill usage without presenting it as explicit calls', async ({ page }) => {
    await page.locator('button:has-text("Sessions")').click();
    await expect(page.locator('[data-od-id="session-kpi-row"]')).toContainText('Skill uses');
    await expect(page.locator('[data-od-id="session-kpi-row"]')).toContainText('Inferred from SKILL.md reads');
    await expect(page.locator('[data-od-id="skill-usage"]')).toContainText('Conservatively inferred from process-level SKILL.md reads');
    await expect(page.locator('[data-od-id="skill-usage"]')).toContainText('7 total · inferred');
    await expect(page.locator('[data-od-id="skill-usage"]')).toContainText('implement');
    await page.locator('[data-od-id="session-detail-table"] tbody tr').first().click();
    const detailDialog = page.locator('[data-od-id="session-detail-dialog"]');
    await expect(detailDialog).toContainText('Skill uses · inferred');
    const skillStep = detailDialog.locator('article').filter({ hasText: 'Skill · implement' });
    await expect(skillStep).toContainText('Skill implement inferred from process');
    await expect(skillStep).toContainText('inferred');
  });
});

test.describe('Agent: Pi', () => {
  // 使用两个 agent 使切换器可见（单个 agent 时切换器隐藏，Pi 按钮不渲染）
  test.beforeEach(async ({ page }) => {
    await setupPage(page, { agents: ['claude', 'pi'] });
  });

  test('Pi appears in the agent menu', async ({ page }) => {
    await page.locator('button[aria-haspopup="menu"]').click();
    await expect(page.getByRole('menuitemradio', { name: 'Pi' })).toBeVisible();
  });

  test('hides analytics section for Pi', async ({ page }) => {
    await selectAgent(page, 'Pi');
    await page.waitForTimeout(2000);

    await expect(page.locator('button[aria-haspopup="menu"]')).toContainText('Pi');

    await expect(page.locator('text=Code Change Trend')).not.toBeVisible();
  });

  test('shows KPI data for Pi', async ({ page }) => {
    await selectAgent(page, 'Pi');
    await page.waitForTimeout(2000);
    await expect(page.locator('span:text-is("Total tokens")')).toBeVisible();
  });
});

test.describe('Dashboard refresh', () => {
  test('manual refresh bypasses cached dashboard endpoints', async ({ page }) => {
    await setupPage(page);
    const paths = ['daily', 'projects', 'blocks', 'analytics'];
    const refreshRequests = paths.map(path => page.waitForRequest(request => {
      const url = new URL(request.url());
      return url.pathname === `/api/${path}` && url.searchParams.get('refresh') === '1';
    }));

    await page.locator('button[title^="刷新数据"]').click();
    await Promise.all(refreshRequests);
  });

  test('all-project totals prefer fresh daily data when project cache is stale', async ({ page }) => {
    await mockApiRoutes(page, { agents: ['codex'], staleProjectsForAgent: 'codex' });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('text=Total tokens', { timeout: 15000 });
    await page.locator('button:has-text("Today")').click();

    const expectedTodayTotal = generateDailyResponse('codex').daily.at(-1)!.totalTokens;
    const totalCard = page.locator('div:has(> span:text-is("Total tokens"))').first();
    await expect(totalCard.locator('span').nth(1)).toHaveText(formatTokens(expectedTodayTotal));
  });
});

test.describe('Codex data-source settings', () => {
  test('opens custom path settings and saves configured sources', async ({ page }) => {
    await setupPage(page);
    const settingsRequest = page.waitForResponse(response => response.url().includes('/api/settings') && response.request().method() === 'GET');
    await page.locator('button[aria-label="Configure Codex data sources"]').click();
    await settingsRequest;

    await expect(page.locator('text=Codex data sources')).toBeVisible();
    await expect(page.locator('text=Multiple paths are supported')).toBeVisible();
    await expect(page.locator('textarea')).toHaveValue('/Users/test/.custom-codex');

    const putRequest = page.waitForRequest(request => request.url().includes('/api/settings/codex-data-paths') && request.method() === 'PUT');
    await page.locator('textarea').fill('/Users/test/.custom-codex\n/Users/test/.another-codex');
    await page.locator('button:has-text("Save paths")').click();
    const request = await putRequest;
    expect(request.postDataJSON()).toEqual({ paths: ['/Users/test/.custom-codex', '/Users/test/.another-codex'] });
    await expect(page.locator('text=Dashboard data is refreshing')).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Time Range tests
// ---------------------------------------------------------------------------

test.describe('Time range: Today', () => {
  test.beforeEach(async ({ page }) => {
    await setupPage(page);
    await page.locator('button:has-text("Today")').click();
    await page.waitForTimeout(1000);
  });

  test('heatmap shows single "Today" row instead of 7 days', async ({ page }) => {
    // Should show "Today" label instead of Sun/Mon/Tue...
    await expect(page.locator('div:has-text("Today")').first()).toBeVisible();
    // Should NOT show all 7 day labels
    const sunLabel = page.locator('text=Sun').first();
    const sunVisible = await sunLabel.isVisible().catch(() => false);
    expect(sunVisible).toBe(false);
  });

  test('model trend chart uses hourly x-axis', async ({ page }) => {
    const chart = page.locator('text=Model trend');
    await expect(chart).toBeVisible();
    // Subtitle should mention "Hourly breakdown"
    await expect(page.locator('text=Hourly breakdown')).toBeVisible();
  });

  test('cache chart renders in today view', async ({ page }) => {
    // Cache efficiency panel heading (exact match)
    await expect(page.getByRole('heading', { name: 'Cache efficiency & savings' })).toBeVisible();
  });
});

test.describe('Time range: 7D', () => {
  test.beforeEach(async ({ page }) => {
    await setupPage(page);
    await page.locator('button:has-text("7D")').click();
    await page.waitForTimeout(1000);
  });

  test('shows 7-day heatmap with day labels', async ({ page }) => {
    await expect(page.locator('text=24-Hour Activity Heatmap')).toBeVisible();
  });

  test('KPI values reflect 7-day window', async ({ page }) => {
    await expect(page.locator('span:text-is("Total tokens")')).toBeVisible();
    const activeDays = page.locator('text=active days');
    await expect(activeDays).toBeVisible();
  });
});

test.describe('Time range: 30D', () => {
  test.beforeEach(async ({ page }) => {
    await setupPage(page);
  });

  test('30D is selected by default', async ({ page }) => {
    const btn30d = page.locator('button:has-text("30D")');
    const classes = await btn30d.getAttribute('class') || '';
    // Active filter tab uses bg-stone-800 (not bg-white like agent buttons)
    expect(classes).toContain('bg-stone-800');
  });

  test('model trend chart shows date x-axis', async ({ page }) => {
    await expect(page.locator('text=Model trend')).toBeVisible();
    // Should NOT show "Hourly breakdown" subtitle
    const hourly = page.locator('text=Hourly breakdown');
    const visible = await hourly.isVisible().catch(() => false);
    expect(visible).toBe(false);
  });
});

test.describe('Time range: 60D', () => {
  test.beforeEach(async ({ page }) => {
    await setupPage(page);
    await page.locator('button:has-text("60D")').click();
    await page.waitForTimeout(1000);
  });

  test('shows data after switching to 60D', async ({ page }) => {
    await expect(page.locator('span:text-is("Total tokens")')).toBeVisible();
    await expect(page.locator('text=Model trend')).toBeVisible();
    await expect(page.locator('text=24-Hour Activity Heatmap')).toBeVisible();
  });
});

test.describe('Time range: ALL', () => {
  test.beforeEach(async ({ page }) => {
    await setupPage(page);
    await page.locator('button:has-text("ALL")').click();
    await page.waitForTimeout(1000);
  });

  test('shows all data including older dates', async ({ page }) => {
    await expect(page.locator('span:text-is("Total tokens")')).toBeVisible();
    const rows = page.locator('table tbody tr');
    const count = await rows.count();
    expect(count).toBeGreaterThan(10);
  });
});

// ---------------------------------------------------------------------------
// Agent switching
// ---------------------------------------------------------------------------

test.describe('Agent switching', () => {
  test('only lists available agents in its menu', async ({ page }) => {
    await setupPage(page, { agents: ['claude', 'opencode'] });

    await page.locator('button[aria-haspopup="menu"]').click();
    await expect(page.getByRole('menuitemradio', { name: 'Claude Code' })).toBeVisible();
    await expect(page.getByRole('menuitemradio', { name: 'OpenCode' })).toBeVisible();

    // Unavailable agents should NOT have tabs
    await expect(page.getByRole('menuitemradio', { name: 'Codex' })).not.toBeVisible();
    await expect(page.getByRole('menuitemradio', { name: 'OpenClaw' })).not.toBeVisible();
  });

  test('hides agent switcher when only one agent available', async ({ page }) => {
    await setupPage(page, { agents: ['claude'] });

    // No agent buttons should be visible at all
    await expect(page.locator('button:has-text("Claude Code")')).not.toBeVisible();
    await expect(page.locator('button:has-text("OpenCode")')).not.toBeVisible();
    await expect(page.locator('button:has-text("Codex")')).not.toBeVisible();
    await expect(page.locator('button:has-text("OpenClaw")')).not.toBeVisible();
  });

  test('switching from Claude to OpenCode updates model names', async ({ page }) => {
    await setupPage(page, { agents: ['claude', 'opencode'] });

    // Claude should show "Sonnet" (from shortModelName)
    await expect(page.locator('text=Model trend')).toBeVisible();

    // Switch to OpenCode
    await selectAgent(page, 'OpenCode');
    await page.waitForTimeout(3000);

    // Should now show OpenCode model names (glm-4.7, mimo-v2.5-pro)
    await expect(page.locator('text=Model trend')).toBeVisible();
    await expect(page.locator('li:has-text("glm")').first()).toBeVisible({ timeout: 5000 });
  });

  test('switching agent updates project list', async ({ page }) => {
    await setupPage(page, { agents: ['claude', 'opencode'] });

    const select = page.locator('select');
    const optsBefore = await select.locator('option').count();

    // Switch to OpenCode
    await selectAgent(page, 'OpenCode');
    await page.waitForTimeout(3000);

    // Project list should update
    await expect(page.locator('select')).toBeVisible();
    const optsAfter = await page.locator('select').locator('option').count();
    expect(optsAfter).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Metric switching (Tokens vs Cost)
// ---------------------------------------------------------------------------

test.describe('Metric switching', () => {
  test.beforeEach(async ({ page }) => {
    await setupPage(page);
  });

  test('switching to Cost metric updates chart data', async ({ page }) => {
    await expect(page.locator('text=Model trend')).toBeVisible();
    await page.locator('button:has-text("Cost")').click();
    await page.waitForTimeout(500);
    await expect(page.locator('text=Model trend')).toBeVisible();
  });

  test('heatmap renders in cost mode', async ({ page }) => {
    await page.locator('button:has-text("Cost")').click();
    await page.waitForTimeout(500);
    await expect(page.locator('text=24-Hour Activity Heatmap')).toBeVisible();
    const cells = page.locator('[class*="rounded-[3px]"]');
    const cellCount = await cells.count();
    expect(cellCount).toBeGreaterThan(0);
  });

  test('Sessions renders session analytics and opens metadata detail', async ({ page }) => {
    await page.locator('button:has-text("Sessions")').click();
    await expect(page.locator('text=Session analytics')).toBeVisible();
    await expect(page.locator('text=LLM call trend')).toBeVisible();
    await expect(page.locator('text=Tool call distribution')).toBeVisible();
    await expect(page.getByText('Bash', { exact: true })).toBeVisible();
    await expect(page.locator('text=Skill usage')).toBeVisible();
    await expect(page.locator('text=frontend-design')).toBeVisible();
    await expect(page.locator('text=Avg. user turns per session')).not.toBeVisible();
    await expect(page.locator('[data-od-id="session-detail-table"] th', { hasText: 'Status' })).toHaveCount(0);
    await expect(page.locator('text=Session detail')).toBeVisible();
    await expect(page.getByText('Session task 1', { exact: true })).toBeVisible();

    await page.locator('[data-od-id="session-detail-table"] tbody tr').first().click();
    const detailDialog = page.locator('[data-od-id="session-detail-dialog"]');
    await expect(detailDialog).toBeVisible();
    expect(await detailDialog.getByRole('button', { name: 'Retry' }).count()).toBe(0);
    await expect(page.getByText('Session overview', { exact: true })).toBeVisible();
    await expect(page.getByText('Tasks in this session', { exact: true })).toBeVisible();
    const selectedTaskOverview = detailDialog.locator('[data-od-id="selected-task-overview"]');
    const taskInput = detailDialog.locator('[data-od-id="task-input"]');
    const taskActivity = detailDialog.locator('[data-od-id="task-activity"]');
    await expect(selectedTaskOverview.getByText('Task overview', { exact: true })).toBeVisible();
    await expect(taskInput.getByText('Input · Task 1', { exact: true })).toBeVisible();
    await expect(taskInput.getByText('User message', { exact: true })).toBeVisible();
    const contextToggle = taskInput.getByRole('button', { name: /Context inputs/ });
    await expect(contextToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(taskInput.getByText('System prompt', { exact: true })).not.toBeVisible();
    await contextToggle.click();
    await expect(contextToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(taskInput.getByText('System prompt', { exact: true })).toBeVisible();
    await expect(taskInput.getByText('AGENTS.md instructions', { exact: true })).toBeVisible();
    await taskInput.getByRole('button', { name: 'Read full context' }).first().click();
    await expect(taskInput.getByText('Preserve user files and verify implementation changes before reporting completion.', { exact: false })).toBeVisible();
    const taskSectionOrder = await detailDialog.locator('[data-od-id="selected-task-overview"], [data-od-id="task-input"], [data-od-id="task-activity"]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-od-id')));
    expect(taskSectionOrder).toEqual(['selected-task-overview', 'task-input', 'task-activity']);
    await expect(detailDialog.getByText('Review the dashboard’s session analytics detail and make the run history easier to inspect.', { exact: true }).last()).toBeVisible();
    await expect(page.getByText('I need to inspect the event model before deciding how the detail view should group requests, responses, and tool invocations.', { exact: true })).toBeVisible();
    await detailDialog.locator('article').filter({ hasText: 'Model reasoning' }).getByRole('button', { name: 'Show details' }).click();
    await expect(page.getByText('The reasoning must remain visible alongside the final model response.', { exact: false })).toBeVisible();
    await expect(detailDialog.getByText('Final response', { exact: true }).first()).toBeVisible();
    await expect(detailDialog.getByText('I traced the session detail flow and identified where the event metadata loses the meaningful request and response content.', { exact: true })).toBeVisible();
    await taskInput.getByRole('button', { name: 'Show full message' }).click();
    await expect(page.getByText('Include the user input, tool arguments, tool results, and the final assistant response.', { exact: false })).toBeVisible();
    await detailDialog.locator('article').filter({ hasText: 'Tool · Read' }).getByRole('button', { name: 'Show details' }).click();
    await expect(page.getByText('Parameters', { exact: true })).toBeVisible();
    await expect(page.locator('text=src/client/Dashboard.tsx')).toBeVisible();
    const taskTwo = detailDialog.getByRole('button', { name: 'Task 2 Now verify that the next task keeps its own request, progress, and answer together.', exact: true });
    await expect(taskTwo).toBeVisible();
    await taskTwo.click();
    await expect(taskInput.getByText('Input · Task 2', { exact: true })).toBeVisible();
    await expect(taskInput.getByText('User message', { exact: true })).toBeVisible();
    await expect(taskInput.getByRole('button', { name: /Context inputs/ })).toHaveAttribute('aria-expanded', 'false');
    await expect(taskInput.getByText('Unchanged from Task 1', { exact: true })).toBeVisible();
    await expect(detailDialog.getByText('The second task is independently grouped and does not show the first task’s events.', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-od-id="session-detail-dialog"]')).not.toBeVisible();
  });

  test('Task input applies context updates without retaining the replaced value', async ({ page }) => {
    await page.route('**/api/sessions/**', async route => {
      const url = new URL(route.request().url());
      const agent = url.searchParams.get('agent') || 'claude';
      const detail = generateSessionDetail(agent, decodeURIComponent(url.pathname.split('/').at(-1) || 'session'));
      const firstRequest = detail.events.findIndex(event => event.id === 'user-1');
      detail.events.splice(firstRequest, 0, {
        id: 'context-developer-1',
        timestamp: new Date(Date.parse(detail.session.startedAt) - 500).toISOString(),
        type: 'input_context',
        inputKind: 'developer',
        contextLabel: 'Developer instructions',
        summary: 'Developer input · Developer instructions',
        contentPreview: 'Use the original task layout.',
        contentAvailable: true,
      });
      const secondRequest = detail.events.findIndex(event => event.id === 'user-2');
      detail.events.splice(secondRequest, 0, {
        id: 'context-developer-2',
        timestamp: new Date(Date.parse(detail.session.startedAt) + 59_000).toISOString(),
        type: 'input_context',
        inputKind: 'developer',
        contextLabel: 'Developer instructions',
        summary: 'Developer input · Developer instructions',
        contentPreview: 'Use the revised task layout.',
        contentAvailable: true,
      });
      await route.fulfill({ json: detail });
    });

    await page.locator('button:has-text("Sessions")').click();
    await page.locator('[data-od-id="session-detail-table"] tbody tr').first().click();
    const detailDialog = page.locator('[data-od-id="session-detail-dialog"]');
    const taskInput = detailDialog.locator('[data-od-id="task-input"]');
    await taskInput.getByRole('button', { name: /Context inputs/ }).click();
    await expect(taskInput.getByText('Use the original task layout.', { exact: true })).toBeVisible();

    await detailDialog.getByRole('button', { name: 'Task 2 Now verify that the next task keeps its own request, progress, and answer together.', exact: true }).click();
    const contextToggle = taskInput.getByRole('button', { name: /Context inputs/ });
    await expect(contextToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(taskInput.getByText('Unchanged from Task 1', { exact: true })).toHaveCount(0);
    await contextToggle.click();
    await expect(taskInput.getByText('Use the revised task layout.', { exact: true })).toBeVisible();
    await expect(taskInput.getByText('Use the original task layout.', { exact: true })).toHaveCount(0);
  });

  test('expanding readable detail keeps the task dialog in place while content loads', async ({ page }) => {
    await page.route('**/api/sessions/**', async route => {
      const url = new URL(route.request().url());
      const includeContent = url.searchParams.get('include') === 'content';
      if (includeContent) await page.waitForTimeout(750);
      const agent = url.searchParams.get('agent') || 'claude';
      const detail = generateSessionDetail(agent, decodeURIComponent(url.pathname.split('/').at(-1) || 'session'));
      await route.fulfill({ json: includeContent ? detail : { ...detail, events: detail.events.map(({ content: _content, ...event }) => event) } });
    });

    await page.locator('button:has-text("Sessions")').click();
    await page.locator('[data-od-id="session-detail-table"] tbody tr').first().click();
    const detailDialog = page.locator('[data-od-id="session-detail-dialog"]');
    await expect(detailDialog.getByRole('button', { name: 'Read full reasoning' })).toBeVisible();
    await detailDialog.getByRole('button', { name: 'Read full reasoning' }).click();

    await page.waitForTimeout(100);
    expect(await detailDialog.locator('nav[aria-label="Tasks in this session"]').isVisible()).toBe(true);
    expect(await detailDialog.locator('.skeleton').count()).toBe(0);
    await expect(detailDialog.getByText('Full reasoning', { exact: true })).toBeVisible();
  });

  test('Sessions performs one stable initial request instead of reloading continuously', async ({ page }) => {
    let sessionAnalyticsRequests = 0;
    page.on('request', request => {
      if (new URL(request.url()).pathname === '/api/session-analytics') sessionAnalyticsRequests++;
    });

    await page.locator('button:has-text("Sessions")').click();
    await expect(page.locator('text=Session analytics')).toBeVisible();
    await page.waitForTimeout(800);

    expect(sessionAnalyticsRequests).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Project filter
// ---------------------------------------------------------------------------

test.describe('Project filter', () => {
  test.beforeEach(async ({ page }) => {
    await setupPage(page);
  });

  test('selecting a project filters data', async ({ page }) => {
    const select = page.locator('select');
    await expect(select).toBeVisible();

    const options = select.locator('option');
    const optCount = await options.count();
    if (optCount > 1) {
      const secondOptValue = await options.nth(1).getAttribute('value');
      if (secondOptValue) {
        await select.selectOption({ value: secondOptValue });
        await page.waitForTimeout(1000);
        await expect(page.locator('span:text-is("Total tokens")')).toBeVisible();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Chart rendering checks
// ---------------------------------------------------------------------------

test.describe('Chart rendering', () => {
  test.beforeEach(async ({ page }) => {
    await setupPage(page);
  });

  test('model distribution pie chart renders', async ({ page }) => {
    await expect(page.locator('text=Model distribution')).toBeVisible();
  });

  test('project distribution chart renders', async ({ page }) => {
    await expect(page.locator('text=Project distribution')).toBeVisible();
  });

  test('cache efficiency shows savings data', async ({ page }) => {
    await expect(page.locator('text=Est. Cost Saved')).toBeVisible();
    await expect(page.locator('text=Tokens Saved')).toBeVisible();
    await expect(page.locator('text=Avg Hit Rate')).toBeVisible();
  });

  test('output/input ratio chart renders when project selected', async ({ page }) => {
    // Output/Input ratio panel only shows when a specific project is selected
    const select = page.locator('select');
    const options = select.locator('option');
    const optCount = await options.count();
    if (optCount > 1) {
      const secondOptValue = await options.nth(1).getAttribute('value');
      if (secondOptValue) {
        await select.selectOption({ value: secondOptValue });
        await page.waitForTimeout(1000);
        await expect(page.getByRole('heading', { name: 'Output / Input ratio' })).toBeVisible({ timeout: 5000 });
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

test.describe('Error handling', () => {
  test('no console errors on load', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await setupPage(page);
    await page.waitForTimeout(2000);

    const appErrors = errors.filter(e => !e.includes('inject.min.js') && !e.includes('DevTools'));
    expect(appErrors).toEqual([]);
  });

  test('handles empty blocks by showing empty heatmap', async ({ page }) => {
    await mockApiRoutes(page, { agents: ['claude'], noBlocks: true });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('text=Total tokens', { timeout: 15000 });

    // Heatmap should still render (with all cells gray/zero)
    await expect(page.locator('text=24-Hour Activity Heatmap')).toBeVisible();
    // All cells should have gray background (no activity)
    const coloredCells = page.locator('[style*="rgba(16, 185, 129"]');
    const count = await coloredCells.count();
    expect(count).toBe(0);
  });
});
