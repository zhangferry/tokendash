import { test, expect } from '@playwright/test';

test.describe('Dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // Wait for data to load
    await page.waitForSelector('text=Total tokens', { timeout: 10000 });
  });

  test('loads and displays KPI cards', async ({ page }) => {
    await expect(page.locator('span:text-is("Total tokens")')).toBeVisible();
    await expect(page.locator('span:text-is("Daily avg")')).toBeVisible();
    await expect(page.locator('span:text-is("Cache hit")')).toBeVisible();
    await expect(page.locator('span:text-is("Output/Input")')).toBeVisible();
  });

  test('heatmap renders with token metric', async ({ page }) => {
    const heatmap = page.locator('text=24-Hour Activity Heatmap');
    await expect(heatmap).toBeVisible();

    // Heatmap should have colored cells (green background means data exists)
    const cells = page.locator('[class*="rounded-[3px]"]');
    const cellCount = await cells.count();
    expect(cellCount).toBeGreaterThan(0);

    // At least some cells should have non-gray background (activity exists)
    const coloredCells = page.locator('[style*="rgba(16, 185, 129"]');
    await expect(coloredCells.first()).toBeVisible({ timeout: 5000 });
  });

  test('heatmap renders with cost metric', async ({ page }) => {
    // Switch to Cost metric
    await page.locator('button:has-text("Cost")').click();

    // Wait for re-render
    await page.waitForTimeout(1000);

    const heatmap = page.locator('text=24-Hour Activity Heatmap');
    await expect(heatmap).toBeVisible();

    // The bug we fixed: heatmap should still show data in cost mode
    // (previously costUSD was always 0, causing empty heatmap)
    const coloredCells = page.locator('[style*="rgba(16, 185, 129"]');
    const count = await coloredCells.count();
    expect(count).toBeGreaterThan(0);
  });

  test('today by hour panel renders 24 buckets and survives metric switch', async ({ page }) => {
    const panel = page.locator('[data-testid="today-by-hour-panel"]');
    await expect(panel).toBeVisible();
    await expect(page.locator('text=Today by hour')).toBeVisible();

    const bars = page.locator('[data-testid="today-hour-bar"]');
    await expect(bars).toHaveCount(24);

    const tokenValues = await bars.evaluateAll(nodes =>
      nodes.map(node => Number((node as HTMLElement).dataset.value || '0'))
    );
    expect(tokenValues.some(value => value > 0)).toBe(true);
    await expect(panel).toHaveAttribute('data-metric', 'tokens');

    await page.locator('button:has-text("Cost")').click();
    await expect(panel).toHaveAttribute('data-metric', 'usd');

    const costValues = await bars.evaluateAll(nodes =>
      nodes.map(node => Number((node as HTMLElement).dataset.value || '0'))
    );
    expect(costValues.some(value => value > 0)).toBe(true);
  });

  test('time range switching updates charts', async ({ page }) => {
    // Click 7D
    await page.locator('button:has-text("7D")').click();
    await page.waitForTimeout(500);

    // Click ALL
    await page.locator('button:has-text("ALL")').click();
    await page.waitForTimeout(500);

    // Should still show data
    await expect(page.locator('span:text-is("Total tokens")')).toBeVisible();
  });

  test('agent switcher is visible when multiple agents available', async ({ page }) => {
    // Check if agent buttons exist (depends on local data)
    const claudeBtn = page.locator('button:has-text("Claude Code")');
    const exists = await claudeBtn.isVisible().catch(() => false);
    if (exists) {
      await expect(claudeBtn).toBeVisible();
      // Model trend chart should be visible
      await expect(page.locator('text=Model trend')).toBeVisible();
    }
  });

  test('no console errors on load', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    await page.reload();
    await page.waitForSelector('text=Total tokens', { timeout: 10000 });
    // Allow no JS errors (ignore third-party extension errors)
    const appErrors = errors.filter(e => !e.includes('inject.min.js'));
    expect(appErrors).toEqual([]);
  });
});
