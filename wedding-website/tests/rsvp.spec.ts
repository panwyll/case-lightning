import { expect, test } from './fixtures';
import { openAsGuest, signInAsAdmin } from './helpers';

test.describe('rsvp', () => {
  test('a household replies, and the answers come back on reload', async ({ page }) => {
    await openAsGuest(page, 'dave-collins');

    await page.getByRole('group', { name: 'Is Dave Collins coming?' }).getByText('Coming', { exact: true }).click();
    await page.getByLabel('Starter', { exact: true }).first().selectOption('garlic-bread');
    await page.getByLabel('Main', { exact: true }).first().selectOption('well-done');
    await page.getByLabel('Pudding', { exact: true }).first().selectOption('viennetta');
    await page.getByLabel('Allergies or anything the kitchen should know').first().fill('Claims shellfish');

    await page
      .getByRole('group', { name: 'Is Priya Rao coming?' })
      .getByText("Can't make it", { exact: true })
      .click();

    await page.getByLabel('Anything you want to tell us').fill('Wouldn\'t miss it.');
    await page.getByRole('button', { name: 'Send our answers' }).click();
    await expect(page.getByRole('status')).toContainText('Saved');

    await page.reload();
    await expect(page.getByRole('button', { name: 'Update our answers' })).toBeVisible();
    await expect(page.getByLabel('Pudding', { exact: true }).first()).toHaveValue('viennetta');
    await expect(page.getByLabel('Anything you want to tell us')).toHaveValue("Wouldn't miss it.");
  });

  test('an unanswered person blocks submission', async ({ page }) => {
    await openAsGuest(page, 'the-shahs');
    await page.getByRole('group', { name: 'Is Nisha Shah coming?' }).getByText('Coming', { exact: true }).click();
    await page.getByRole('button', { name: /answers/ }).click();
    // `.first()` skips Next's own route announcer, which also has role=alert.
    await expect(page.getByRole('alert').first()).toContainText('Raj Shah');
  });

  test('you cannot answer on behalf of a page that is not yours', async ({ page }) => {
    await openAsGuest(page, 'nan');
    const response = await page.request.post('/api/rsvp', {
      data: {
        slug: 'dave-collins',
        members: [{ memberId: 'dave', attending: true, choices: {} }],
        extras: {},
      },
    });
    expect(response.status()).toBe(403);
  });

  test('a menu option from someone else\'s page is discarded', async ({ page }) => {
    await openAsGuest(page, 'nan');
    const response = await page.request.post('/api/rsvp', {
      data: {
        slug: 'nan',
        // 'viennetta' only exists on Dave's menu.
        members: [{ memberId: 'nan', attending: true, choices: { pudding: 'viennetta' } }],
        extras: {},
      },
    });
    expect(response.ok()).toBeTruthy();

    await signInAsAdmin(page);
    await page.goto('/admin/g/nan');
    await expect(page.getByText('Viennetta')).toHaveCount(0);
  });
});
