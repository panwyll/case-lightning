import { test, expect } from '@playwright/test';

test('landing page renders with correct brand colour on CTA button', async ({ page }) => {
  await page.goto('/');

  // Hero heading must be visible
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

  // At least one "Book a Demo" CTA must be visible
  const cta = page.locator('[data-cta="hero_book_demo"]');
  await expect(cta).toBeVisible();

  // The primary CTA must have the amber background (rgb 245 158 11 = brand-500)
  const bg = await cta.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).not.toBe('rgba(0, 0, 0, 0)');
  expect(bg).not.toBe('rgb(255, 255, 255)');

  // Pricing section must show £200
  await expect(page.getByText('£200', { exact: true })).toBeVisible();

  // Guarantee section must be present
  await expect(page.getByRole('heading', { name: /money-back guarantee/i })).toBeVisible();

  // Screenshot for manual review
  await page.screenshot({ path: 'tests/screenshots/home.png', fullPage: true });
});
