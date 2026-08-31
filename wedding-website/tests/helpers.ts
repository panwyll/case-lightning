import type { Page } from '@playwright/test';
import { TEST_ENV } from '../playwright.config';

/**
 * Recomputes a guest's access code exactly as the server does. Importing
 * lib/auth directly would read the test process's own environment, so the
 * derivation is repeated here against the known test secret.
 */
const ALPHABET = '0123456789BCDFGHJKLMNPQRSTVWXZ';

export async function guestCodeFor(slug: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(TEST_ENV.GUEST_LINK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(slug)));
  let code = '';
  for (let i = 0; i < 8; i++) code += ALPHABET[sig[i] % ALPHABET.length];
  return code;
}

export async function signInToSite(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Password from your invitation').fill(TEST_ENV.SITE_PASSWORD);
  await page.getByRole('button', { name: 'Come in' }).click();
  await page.waitForURL('**/');
}

export async function signInAsAdmin(page: Page): Promise<void> {
  await page.goto('/admin/login');
  await page.getByLabel('Admin password').fill(TEST_ENV.ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/admin');
}

export async function openAsGuest(page: Page, slug: string): Promise<void> {
  const code = await guestCodeFor(slug);
  await page.goto(`/g/${slug}?k=${code}`);
  await page.waitForURL(`**/g/${slug}`);
}
