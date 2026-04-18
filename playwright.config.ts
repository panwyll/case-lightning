import { defineConfig } from '@playwright/test';
export default defineConfig({
  webServer: {
    command: 'npm run build && npm run start',
    url: 'http://localhost:3000',
    reuseExistingServer: false,
    timeout: 120_000,
  },
  use: { baseURL: 'http://localhost:3000' },
  testDir: './tests',
});
