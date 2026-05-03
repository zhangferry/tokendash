import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  retries: 0,
  use: {
    baseURL: 'http://localhost:3457',
    channel: 'chrome',
  },
  webServer: {
    // Use vite preview to serve built static files.
    // All API calls are mocked via page.route() in tests,
    // so no real backend needed — tests run on any machine/CI.
    command: 'npm run build && npx vite preview --port 3457',
    port: 3457,
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
  },
});
