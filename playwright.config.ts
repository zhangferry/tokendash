import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  retries: 0,
  use: {
    baseURL: 'http://localhost:3456',
    channel: 'chrome',
  },
  webServer: {
    command: 'npm run build && node dist/server/index.js --no-open',
    port: 3456,
    reuseExistingServer: true,
    timeout: 30000,
  },
});
