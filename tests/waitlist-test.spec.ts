import { test, expect, request } from '@playwright/test';

test('waitlist page renders the sign-up form', async ({ page }) => {
  await page.goto('/waitlist');

  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.locator('#first_name')).toBeVisible();
  await expect(page.locator('#surname')).toBeVisible();
  await expect(page.locator('#email')).toBeVisible();
  await expect(page.getByRole('button', { name: /join the waitlist/i })).toBeVisible();
});

test('waitlist form shows success state when API returns ok', async ({ page }) => {
  // Mock the server-side API route so the test passes without real Supabase creds
  await page.route('/api/waitlist', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) })
  );

  await page.goto('/waitlist');

  await page.fill('#first_name', 'Jane');
  await page.fill('#surname', 'Smith');
  await page.fill('#email', 'jane@smithsolicitors.co.uk');

  await page.getByRole('button', { name: /join the waitlist/i }).click();

  await expect(page.getByRole('heading', { name: /you.re on the list/i })).toBeVisible({ timeout: 5000 });
});

test('waitlist form shows error state when API returns an error', async ({ page }) => {
  await page.route('/api/waitlist', (route) =>
    route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'DB error' }) })
  );

  await page.goto('/waitlist');

  await page.fill('#first_name', 'Jane');
  await page.fill('#surname', 'Smith');
  await page.fill('#email', 'jane@smithsolicitors.co.uk');

  await page.getByRole('button', { name: /join the waitlist/i }).click();

  await expect(
    page.locator('p').filter({ hasText: /something went wrong/i })
  ).toBeVisible({ timeout: 5000 });
});

test('POST /api/waitlist with missing fields returns 400', async () => {
  const ctx = await request.newContext({ baseURL: 'http://localhost:3000' });
  const res = await ctx.post('/api/waitlist', {
    data: { first_name: '', surname: '', email: '' },
  });
  expect(res.status()).toBe(400);
  const body = await res.json();
  expect(body).toHaveProperty('error');
  await ctx.dispose();
});

test('POST /api/waitlist with valid payload returns 200 or env-var error', async () => {
  const ctx = await request.newContext({ baseURL: 'http://localhost:3000' });
  const res = await ctx.post('/api/waitlist', {
    data: { first_name: 'Jane', surname: 'Smith', email: 'jane@smithsolicitors.co.uk' },
  });
  // In CI without real Supabase creds the route returns 500 with missing env var details.
  // With real creds it returns 200 { ok: true }.
  expect([200, 500]).toContain(res.status());
  const body = await res.json();
  if (res.status() === 500) {
    expect(body).toHaveProperty('missing');
    expect(Array.isArray(body.missing)).toBe(true);
  } else {
    expect(body).toMatchObject({ ok: true });
  }
  await ctx.dispose();
});
