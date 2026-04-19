import { test, expect } from '@playwright/test';

test('landing page renders with correct brand colour on CTA button', async ({ page }) => {
  await page.goto('/');

  // Hero heading must be visible
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

  // Primary hero CTA must be visible
  const cta = page.locator('[data-cta="hero_start_trial"]');
  await expect(cta).toBeVisible();

  // The primary CTA must have a solid (non-transparent, non-white) background
  const bg = await cta.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).not.toBe('rgba(0, 0, 0, 0)');
  expect(bg).not.toBe('rgb(255, 255, 255)');

  // Pricing section must show £200
  await expect(page.getByText('£200', { exact: true })).toBeVisible();

  // Testimonials section must be present
  await expect(page.getByRole('heading', { name: /what firms are saying/i })).toBeVisible();

  // FAQ section must be present
  await expect(page.getByRole('heading', { name: /questions/i })).toBeVisible();

  // Screenshot for manual review
  await page.screenshot({ path: 'tests/screenshots/home.png', fullPage: true });
});
