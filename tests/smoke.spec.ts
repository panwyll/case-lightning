import { test, expect } from '@playwright/test';

// The marketing site nests CONVEYi under the Case Lightning umbrella: `/` is the umbrella
// home, and the CONVEYi product pages live under `/conveyi/*`.

test('landing page renders with a solid primary CTA', async ({ page }) => {
  await page.goto('/');

  // Hero heading must be visible
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

  // Primary hero CTA must be visible with a solid (non-transparent, non-white) background
  const cta = page.locator('[data-cta="hero_products"]');
  await expect(cta).toBeVisible();
  const bg = await cta.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).not.toBe('rgba(0, 0, 0, 0)');
  expect(bg).not.toBe('rgb(255, 255, 255)');

  // The umbrella links through to the live CONVEYi product
  await expect(page.getByRole('link', { name: /conveyi/i }).first()).toBeVisible();

  // Screenshot for manual review
  await page.screenshot({ path: 'tests/screenshots/home.png', fullPage: true });
});

test('pricing page renders with plan tiers', async ({ page }) => {
  await page.goto('/conveyi/pricing');

  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByText('£39', { exact: true })).toBeVisible();
  await expect(page.getByText('£199', { exact: true })).toBeVisible();
  await expect(page.getByText('£399', { exact: true })).toBeVisible();
});

test('how-it-works page renders', async ({ page }) => {
  await page.goto('/conveyi/how-it-works');

  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByText(/how it works/i).first()).toBeVisible();
});

test('faq page renders', async ({ page }) => {
  await page.goto('/conveyi/faq');

  await expect(page.getByRole('heading', { level: 1, name: /questions/i })).toBeVisible();
});
