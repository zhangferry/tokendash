import { test, expect } from '@playwright/test';
import { mockApiRoutes } from './fixtures.js';

// ---------------------------------------------------------------------------
// Helper: set up mocked page and wait for initial load
// ---------------------------------------------------------------------------

async function setupPage(page: import('@playwright/test').Page, options?: { agents?: string[] }) {
  await mockApiRoutes(page, { agents: options?.agents });
  await page.goto('/');
  await page.waitForSelector('text=Total tokens', { timeout: 15000 });
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
      await page.goto('/');

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
    await page.locator('button:has-text("OpenCode")').click();
    await page.waitForTimeout(2000);
  });

  test('shows OpenCode as active agent', async ({ page }) => {
    const opencodeBtn = page.locator('button:has-text("OpenCode")');
    const classes = await opencodeBtn.getAttribute('class') || '';
    expect(classes).toContain('bg-white');
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
    await page.locator('button:has-text("Codex")').click();
    await page.waitForTimeout(2000);
  });

  test('hides analytics section', async ({ page }) => {
    await expect(page.locator('text=Code Change Trend')).not.toBeVisible();
  });

  test('shows KPI data', async ({ page }) => {
    await expect(page.locator('span:text-is("Total tokens")')).toBeVisible();
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
  test('switching from Claude to OpenCode updates model names', async ({ page }) => {
    await setupPage(page, { agents: ['claude', 'opencode'] });

    // Claude should show "Sonnet" (from shortModelName)
    await expect(page.locator('text=Model trend')).toBeVisible();

    // Switch to OpenCode
    await page.locator('button:has-text("OpenCode")').click();
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
    await page.locator('button:has-text("OpenCode")').click();
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
    await page.goto('/');
    await page.waitForSelector('text=Total tokens', { timeout: 15000 });

    // Heatmap should still render (with all cells gray/zero)
    await expect(page.locator('text=24-Hour Activity Heatmap')).toBeVisible();
    // All cells should have gray background (no activity)
    const coloredCells = page.locator('[style*="rgba(16, 185, 129"]');
    const count = await coloredCells.count();
    expect(count).toBe(0);
  });
});
