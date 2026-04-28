import { test, expect } from '@playwright/test';

test('supabase health check - env vars set and leads table reachable', async ({ request }) => {
  const res = await request.get('/api/health');

  const body = await res.json();

  expect(
    body,
    `Supabase health check failed: ${JSON.stringify(body)}`,
  ).toMatchObject({ ok: true });

  expect(res.status()).toBe(200);
});
