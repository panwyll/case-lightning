import { expect, test } from './fixtures';
import { signInAsAdmin, signInToSite } from './helpers';

test.describe('the front door', () => {
  test('a stranger is sent to the password prompt', async ({ page }) => {
    await page.goto('/schedule');
    await expect(page).toHaveURL(/\/login\?next=%2Fschedule/);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });

  test('the wrong password does not get in', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Password from your invitation').fill('definitely-not-it');
    await page.getByRole('button', { name: 'Come in' }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test('the right password gets in, and lands where you were headed', async ({ page }) => {
    await page.goto('/registry');
    await page.getByLabel('Password from your invitation').fill('thebigday');
    await page.getByRole('button', { name: 'Come in' }).click();
    await page.waitForURL('**/registry');
    await expect(page.getByRole('heading', { name: 'Gifts' })).toBeVisible();
  });

  test('the site password alone does not open the admin area', async ({ page }) => {
    await signInToSite(page);
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/admin\/login/);
  });

  test('the admin password does', async ({ page }) => {
    await signInAsAdmin(page);
    await expect(page.getByRole('heading', { name: 'Guests' })).toBeVisible();
  });

  test('signing out closes everything again', async ({ page }) => {
    await signInToSite(page);
    await page.goto('/api/auth/logout');
    await page.goto('/schedule');
    await expect(page).toHaveURL(/\/login/);
  });
});
