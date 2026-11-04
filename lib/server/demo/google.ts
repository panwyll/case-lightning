/**
 * The demo host's Google Calendar, for the booking page's busy times (lib/server/demo/bookings.ts). Connected once
 * by signing in with Google (app/api/v1/demo/google/connect and callback); only the host's own account
 * (DEMO_HOST_EMAIL) can be connected. The access asked for is free/busy only, so the events themselves are never
 * read, and nothing about the calendar is made public. Needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (an OAuth
 * client in Google Cloud with the Calendar API on).
 */
import { queryOne, query, runAsSystem } from '../db';
import { config } from '../config';
import { decryptSecret, encryptSecret } from '../crypto';
import type { Busy } from './slots';

const env = (k: string) => process.env[k]?.trim() || undefined;
const SCOPE = 'openid email https://www.googleapis.com/auth/calendar.freebusy';

export const googleConfigured = () => !!(env('GOOGLE_CLIENT_ID') && env('GOOGLE_CLIENT_SECRET'));
const redirectUri = () => `${config.appUrl.replace(/\/$/, '')}/api/v1/demo/google/callback`;

/** Where to send the host to sign in with Google. */
export function connectUrl(state: string, hostEmail: string): string {
  const q = new URLSearchParams({
    client_id: env('GOOGLE_CLIENT_ID')!, redirect_uri: redirectUri(), response_type: 'code', scope: SCOPE,
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', login_hint: hostEmail, state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

async function token(body: Record<string, string>): Promise<{ access_token: string; refresh_token?: string; id_token?: string; expires_in: number }> {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env('GOOGLE_CLIENT_ID')!, client_secret: env('GOOGLE_CLIENT_SECRET')!, ...body }),
    signal: AbortSignal.timeout(8000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Google token: ${j.error ?? r.status}${j.error_description ? `, ${j.error_description}` : ''}`);
  return j;
}

/** Finish connecting: the account must be the host's own; its refresh token is kept, encrypted. Returns the account. */
export async function finishConnect(code: string, hostEmail: string): Promise<string> {
  const t = await token({ code, grant_type: 'authorization_code', redirect_uri: redirectUri() });
  // The ID token came straight from Google's token endpoint over TLS, so its claims can be read without checking the signature.
  const claims = t.id_token ? JSON.parse(Buffer.from(t.id_token.split('.')[1], 'base64url').toString('utf8')) : {};
  const account = String(claims.email ?? '').toLowerCase();
  if (!account || claims.email_verified === false) throw new Error('Google did not say which account this is.');
  if (account !== hostEmail.toLowerCase()) throw new Error(`Only ${hostEmail} can be connected; this was ${account}.`);
  const refresh = t.refresh_token;
  if (!refresh) throw new Error('Google gave no lasting access. Remove CONVEYi from your Google account’s third-party access and connect again.');
  await runAsSystem(() => query(
    `insert into demo_calendar (id, account, refresh_token_enc, connected_at) values (1, $1, $2, now())
     on conflict (id) do update set account = excluded.account, refresh_token_enc = excluded.refresh_token_enc, connected_at = now()`,
    [account, encryptSecret(refresh)]));
  access = null;
  return account;
}

/** Which account is connected, if any. */
export async function connectedAccount(): Promise<string | null> {
  const row = await runAsSystem(() => queryOne<{ account: string }>(`select account from demo_calendar where id = 1`)).catch(() => null);
  return row?.account ?? null;
}

let access: { token: string; until: number } | null = null;

/**
 * The host's busy times between two instants, from Google, or null when no calendar is connected. A connected
 * calendar that cannot be read throws, so the caller can say so rather than offer times that may clash.
 */
export async function googleBusy(from: Date, to: Date): Promise<Busy[] | null> {
  if (!googleConfigured()) return null;
  const row = await runAsSystem(() => queryOne<{ refresh_token_enc: string }>(`select refresh_token_enc from demo_calendar where id = 1`)).catch(() => null);
  if (!row) return null;
  if (!access || access.until < Date.now() + 60_000) {
    const t = await token({ refresh_token: decryptSecret(row.refresh_token_enc), grant_type: 'refresh_token' });
    access = { token: t.access_token, until: Date.now() + t.expires_in * 1000 };
  }
  const r = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
    method: 'POST', headers: { authorization: `Bearer ${access.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ timeMin: from.toISOString(), timeMax: to.toISOString(), items: [{ id: 'primary' }] }),
    signal: AbortSignal.timeout(8000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Google free/busy: ${j.error?.message ?? r.status}`);
  const cal = j.calendars?.primary;
  if (cal?.errors?.length) throw new Error(`Google free/busy: ${cal.errors.map((e: { reason: string }) => e.reason).join(', ')}`);
  return (cal?.busy ?? []).map((b: { start: string; end: string }) => ({ start: new Date(b.start), end: new Date(b.end) }));
}
