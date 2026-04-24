import { test, expect } from '@playwright/test';

test('landing page renders with correct brand colour on CTA button', async ({ page }) => {
  await page.goto('/');

  // Hero heading must be visible
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

  // Primary hero CTA must be visible
  const cta = page.locator('[data-cta="hero_signup"]');
  await expect(cta).toBeVisible();

  // The primary CTA must have a solid (non-transparent, non-white) background
  const bg = await cta.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).not.toBe('rgba(0, 0, 0, 0)');
  expect(bg).not.toBe('rgb(255, 255, 255)');

  // Testimonials section must be present
  await expect(page.getByRole('heading', { name: /what firms are saying/i })).toBeVisible();

  // Nav must link to the dedicated section pages
  await expect(page.getByRole('link', { name: /how it works/i })).toBeVisible();
  await expect(page.getByRole('link', { name: /pricing/i })).toBeVisible();
  await expect(page.getByRole('link', { name: /faq/i })).toBeVisible();

  // Screenshot for manual review
  await page.screenshot({ path: 'tests/screenshots/home.png', fullPage: true });
});

test('pricing page renders with plan tiers', async ({ page }) => {
  await page.goto('/pricing');

  await expect(page.getByRole('heading', { level: 1, name: /choose your plan/i })).toBeVisible();
  await expect(page.getByText('£200', { exact: true })).toBeVisible();
  await expect(page.getByText('£499', { exact: true })).toBeVisible();
});

test('how-it-works page renders', async ({ page }) => {
  await page.goto('/how-it-works');

  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByText(/four steps to faster cases/i)).toBeVisible();
});

test('faq page renders', async ({ page }) => {
  await page.goto('/faq');

  await expect(page.getByRole('heading', { level: 1, name: /questions/i })).toBeVisible();
});
