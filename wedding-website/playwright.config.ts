import { defineConfig } from '@playwright/test';

/**
 * The suite runs against a real production build with known secrets, so the
 * tests can derive the same guest codes the app does.
 */
export const TEST_ENV = {
  SESSION_SECRET: 'test-session-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  GUEST_LINK_SECRET: 'test-guest-link-secret-bbbbbbbbbbbbbbbbbbbbbbbb',
  SITE_PASSWORD: 'thebigday',
  ADMIN_PASSWORD: 'backofhouse',
  NEXT_PUBLIC_SITE_URL: 'http://localhost:3100',
};

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    baseURL: 'http://localhost:3100',
    // Escape hatch for sandboxes that ship a Chromium build Playwright did not
    // download itself. Normally unset: `npx playwright install` is enough.
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
      : {},
  },
  webServer: {
    command: 'npm run build && npx next start --port 3100',
    url: 'http://localhost:3100/login',
    reuseExistingServer: false,
    timeout: 180_000,
    env: { ...TEST_ENV, NODE_ENV: 'production' },
  },
});
