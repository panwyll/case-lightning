import { expect, test } from './fixtures';
import { openAsGuest, signInAsAdmin } from './helpers';

test.describe('back of house', () => {
  test('the dashboard lists every guest page, drafts included', async ({ page }) => {
    await signInAsAdmin(page);
    await expect(page.getByRole('link', { name: 'Dave', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'The Office Lot' })).toBeVisible();
    await expect(page.getByText('draft')).toHaveCount(1);
  });

  test('an admin can preview a draft page a guest cannot see', async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto('/g/the-office-lot?preview=1');
    await expect(page.getByText('Previewing')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'You are invited to the good half' })).toBeVisible();
  });

  test('an admin preview is not counted as the guest opening it', async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto('/g/the-shahs?preview=1');
    await page.goto('/admin/g/the-shahs');
    await expect(page.getByText('They have not opened it yet.')).toBeVisible();
  });

  test('a real guest visit is recorded', async ({ page }) => {
    await openAsGuest(page, 'the-shahs');
    // The beacon is fire-and-forget; wait for it rather than racing it.
    await page.waitForResponse((r) => r.url().includes('/api/track'));

    await page.context().clearCookies();
    await signInAsAdmin(page);
    await page.goto('/admin/g/the-shahs');
    await expect(page.getByText('They have not opened it yet.')).toHaveCount(0);
  });

  test('the export is a CSV with a row per person', async ({ page }) => {
    await signInAsAdmin(page);
    const response = await page.request.get('/admin/export');
    expect(response.headers()['content-type']).toContain('text/csv');
    const body = await response.text();
    expect(body).toContain('display_name');
    expect(body).toContain('"Aanya Shah"');
    expect(body).toContain('"Margaret Doyle"');
  });

  test('the admin area is closed to a guest session', async ({ page }) => {
    await openAsGuest(page, 'nan');
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/admin\/login/);
    const csv = await page.request.get('/admin/export');
    expect(csv.url()).toContain('/admin/login');
  });
});
