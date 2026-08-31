import { expect, test } from './fixtures';
import { guestCodeFor, openAsGuest, signInToSite } from './helpers';

test.describe('personal pages', () => {
  test('a personal link opens the page and drops the code from the URL', async ({ page }) => {
    const code = await guestCodeFor('dave-collins');
    await page.goto(`/g/dave-collins?k=${code}`);
    await page.waitForURL('**/g/dave-collins');
    await expect(page).not.toHaveURL(/k=/);
    await expect(page.getByRole('heading', { name: /Dave\. You're invited/ })).toBeVisible();
  });

  test('a wrong code does not', async ({ page }) => {
    await page.goto('/g/dave-collins?k=WRONGCODE');
    await expect(page.getByText('That code did not match')).toBeVisible();
    await expect(page.getByRole('heading', { name: /someone/ })).toBeVisible();
  });

  test('the shared password does not open someone else\'s page', async ({ page }) => {
    await signInToSite(page);
    await page.goto('/g/dave-collins');
    await expect(page.getByRole('heading', { name: /someone/ })).toBeVisible();
    await expect(page.getByText('Viennetta')).toHaveCount(0);
  });

  test('one guest cannot read another guest\'s page', async ({ page }) => {
    await openAsGuest(page, 'nan');
    await page.goto('/g/dave-collins');
    await expect(page.getByRole('heading', { name: /someone/ })).toBeVisible();
  });

  test('a draft page is not reachable by a guest', async ({ page }) => {
    const code = await guestCodeFor('the-office-lot');
    await page.goto(`/g/the-office-lot?k=${code}`);
    await expect(page.getByRole('heading', { name: 'Nothing here' })).toBeVisible();
  });

  test('each guest gets their own menu', async ({ page }) => {
    // The menu only appears once someone is marked as coming.
    await openAsGuest(page, 'dave-collins');
    await page
      .getByRole('group', { name: 'Is Dave Collins coming?' })
      .getByText('Coming', { exact: true })
      .click();
    const daveOptions = await page.getByLabel('Pudding', { exact: true }).first().locator('option').allTextContents();
    expect(daveOptions).toContain('A whole Viennetta, unsliced, handed to you');

    await page.context().clearCookies();
    await openAsGuest(page, 'nan');
    await page
      .getByRole('group', { name: 'Is Margaret Doyle coming?' })
      .getByText('Coming', { exact: true })
      .click();
    const nanOptions = await page.getByLabel('Pudding', { exact: true }).first().locator('option').allTextContents();
    expect(nanOptions).toContain('Cheese and biscuits');
    expect(nanOptions.join(' ')).not.toContain('Viennetta');
  });

  test('the schedule hides parts of the day a guest is not invited to', async ({ page }) => {
    await openAsGuest(page, 'nan'); // no 'brunch' in invitedTo
    await page.goto('/schedule');
    await expect(page.getByText('Brunch, the next day')).toHaveCount(0);

    await page.context().clearCookies();
    await openAsGuest(page, 'dave-collins'); // has 'brunch'
    await page.goto('/schedule');
    await expect(page.getByText('Brunch, the next day')).toHaveCount(1);
  });
});
