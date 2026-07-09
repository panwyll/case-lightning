import { NextResponse } from 'next/server';
import { config } from '@/lib/server/config';
import { SESSION_COOKIE } from '@/lib/server/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Sign out: clear the session cookie. GET bounces to the web app's sign-in gate (a link
 * the user can click); POST just clears and returns ok (the taskpane calls this, then
 * clears its bearer token and drops to the Connect screen). We deliberately do NOT
 * redirect into a fresh OAuth flow — signing out should land on "sign in", not re-log-in.
 */
function clear(res: NextResponse): NextResponse {
  res.cookies.delete(SESSION_COOKIE);
  return res;
}

export async function GET() {
  return clear(NextResponse.redirect(`${config.appUrl.replace(/\/$/, '')}/admin`));
}

export async function POST() {
  return clear(NextResponse.json({ ok: true }));
}
