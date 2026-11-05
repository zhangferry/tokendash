import { expect, test } from '@playwright/test';
import { mockApiRoutes } from './fixtures.js';

test('DeepSeek-only installation exposes usage, filters and real session details', async ({ page }) => {
  await mockApiRoutes(page, { agents: ['deepseek'] });
  await page.goto('/');
  await expect(page.locator('button[aria-haspopup="menu"]')).toContainText('DeepSeek Harness');
  await expect(page.locator('span:text-is("Total tokens")')).toBeVisible();
  await expect(page.getByText('Model trend', { exact: true })).toBeVisible();
  const project = page.locator('select').first();
  await expect(project.locator('option')).toHaveCount(3);
  await project.selectOption({ index: 1 });
  await expect(page.locator('span:text-is("Total tokens")')).toBeVisible();
  await project.selectOption({ index: 0 });

  await page.getByRole('button', { name: 'Sessions', exact: true }).click();
  await expect(page.getByText('Session analytics', { exact: true })).toBeVisible();
  await expect(page.locator('[data-od-id="session-kpi-row"]')).not.toContainText('Skill uses');
  await expect(page.getByText('Tool call distribution', { exact: true })).toBeVisible();
  await page.locator('[data-od-id="session-detail-table"] tbody tr').first().click();
  const dialog = page.locator('[data-od-id="session-detail-dialog"]');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Session overview', { exact: true })).toBeVisible();
  await expect(dialog.locator('[data-od-id="task-input"]')).toContainText('Review the dashboard');
});

test('All Agents keeps healthy usage visible when DeepSeek fails and marks partial data', async ({ page }) => {
  await mockApiRoutes(page, { agents: ['claude', 'deepseek'], failedAgent: 'deepseek' });
  await page.goto('/');
  await expect(page.locator('span:text-is("Total tokens")')).toBeVisible();
  await page.locator('button[aria-haspopup="menu"]').click();
  await page.getByRole('menuitemradio', { name: 'All Agents' }).click();
  await expect(page.locator('span:text-is("Total tokens")')).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: /deepseek|DeepSeek/ }).first()).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: /unavailable|incomplete/i }).first()).toBeVisible();
});

test('DeepSeek API failures are visible in single-source mode', async ({ page }) => {
  await mockApiRoutes(page, { agents: ['deepseek'], failedAgent: 'deepseek' });
  await page.goto('/');
  await expect(page.getByText(/Failed to fetch/).first()).toBeVisible();
});

test('failed All Agents daily refresh retains prior totals with a stale-data warning', async ({ page }) => {
  await mockApiRoutes(page, { agents: ['claude', 'deepseek'] });
  await page.goto('/');
  await expect(page.locator('span:text-is("Total tokens")')).toBeVisible();
  const allLoaded = page.waitForResponse(response => response.url().includes('/api/daily?agent=deepseek') && response.ok());
  await page.locator('button[aria-haspopup="menu"]').click();
  await page.getByRole('menuitemradio', { name: 'All Agents' }).click();
  await allLoaded;
  await page.waitForLoadState('networkidle');
  await expect(page.locator('button[aria-haspopup="menu"]')).toContainText('All Agents');
  await page.route('**/api/daily*', route => route.fulfill({ status: 502, json: { error: 'Daily source unavailable' } }));
  await page.getByRole('button', { name: /Refresh data/ }).click();
  await expect(page.getByRole('alert')).toContainText('Totals retain the last successful data');
  await expect(page.locator('span:text-is("Total tokens")')).toBeVisible();
});
