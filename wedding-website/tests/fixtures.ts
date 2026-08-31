import { test as base } from '@playwright/test';

/**
 * Every test runs against the app alone. Third-party requests (the webfont
 * stylesheet) are cut off at the browser, so the suite is hermetic and a slow
 * or unreachable CDN can never stall the page load event.
 */
export const test = base.extend<{ hermetic: void }>({
  hermetic: [
    async ({ page }, use) => {
      await page.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return route.continue();
        return route.abort();
      });
      await use();
    },
    { auto: true },
  ],
});

export { expect } from '@playwright/test';
