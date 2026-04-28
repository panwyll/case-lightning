import { test, expect } from '@playwright/test';

test('waitlist form submission shows error', async ({ page }) => {
  const consoleMessages: string[] = [];
  const networkErrors: string[] = [];

  page.on('console', msg => consoleMessages.push(`[${msg.type()}] ${msg.text()}`));
  page.on('requestfailed', req => networkErrors.push(`FAILED: ${req.url()} - ${req.failure()?.errorText}`));
  page.on('response', async res => {
    if (!res.ok() && res.url().includes('supabase')) {
      const body = await res.text().catch(() => '');
      networkErrors.push(`HTTP ${res.status()} ${res.url()}: ${body}`);
    }
  });

  await page.goto('/waitlist');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

  // Fill in the form
  await page.fill('#first_name', 'Test');
  await page.fill('#surname', 'User');
  await page.fill('#email', 'test@example.com');

  await page.screenshot({ path: 'tests/screenshots/waitlist-filled.png' });

  // Submit
  await page.click('button[type="submit"]');
  await page.waitForTimeout(3000);

  await page.screenshot({ path: 'tests/screenshots/waitlist-after-submit.png' });

  // Check for error message
  const errorEl = page.locator('p').filter({ hasText: /something went wrong/i });
  const successEl = page.locator('h2').filter({ hasText: /you're on the list/i });

  const hasError = await errorEl.count() > 0;
  const hasSuccess = await successEl.count() > 0;

  console.log('Has error:', hasError);
  console.log('Has success:', hasSuccess);
  console.log('Console messages:', consoleMessages.join('\n'));
  console.log('Network errors:', networkErrors.join('\n'));

  // Print page content for diagnosis
  const content = await page.textContent('body');
  console.log('Page body snippet:', content?.substring(0, 500));
});
