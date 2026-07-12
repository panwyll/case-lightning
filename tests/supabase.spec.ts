import { test, expect } from '@playwright/test';

// Health check tolerant of CI without Supabase creds: with real creds the route returns
// 200 { ok: true }; without them it reports what's missing/unreachable (500) rather than
// pretending to be healthy. Both are acceptable — we're asserting the route behaves, not
// that CI happens to hold secrets.
test('supabase health check - route responds coherently', async ({ request }) => {
  const res = await request.get('/api/health');
  const body = await res.json();

  expect(
    [200, 500],
    `Unexpected health status ${res.status()}: ${JSON.stringify(body)}`,
  ).toContain(res.status());

  if (res.status() === 200) {
    expect(body).toMatchObject({ ok: true });
  } else {
    expect(body.ok).toBe(false);
    expect(typeof body.error).toBe('string');
  }
});
