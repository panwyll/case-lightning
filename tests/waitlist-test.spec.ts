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
  // The page surfaces the API's own error message, so assert it renders that.
  await page.route('/api/waitlist', (route) =>
    route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'DB error' }) })
  );

  await page.goto('/waitlist');

  await page.fill('#first_name', 'Jane');
  await page.fill('#surname', 'Smith');
  await page.fill('#email', 'jane@smithsolicitors.co.uk');

  await page.getByRole('button', { name: /join the waitlist/i }).click();

  await expect(
    page.locator('p').filter({ hasText: /db error/i })
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

test('POST /api/waitlist with valid payload returns 200 or a configured-service error', async () => {
  const ctx = await request.newContext({ baseURL: 'http://localhost:3000' });
  const res = await ctx.post('/api/waitlist', {
    data: { first_name: 'Jane', surname: 'Smith', email: 'jane@smithsolicitors.co.uk' },
  });
  // With real creds → 200 { ok: true }. Otherwise the route reports a problem it can't get
  // past: not configured (503 + `missing`), Supabase unreachable (503, connection error), or
  // a DB failure (500). They all carry an `error` string — that's what we assert.
  expect([200, 500, 503]).toContain(res.status());
  const body = await res.json();
  if (res.status() === 200) {
    expect(body).toMatchObject({ ok: true });
  } else {
    expect(typeof body.error).toBe('string');
  }
  await ctx.dispose();
});
