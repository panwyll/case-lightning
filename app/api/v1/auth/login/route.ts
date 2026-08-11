import { NextRequest, NextResponse } from 'next/server';
import { assertFeature } from '@/lib/server/config';
import { getAuthUrl } from '@/lib/server/oauth';
import { OAUTH_STATE_COOKIE, OAUTH_FLOW_COOKIE } from '@/lib/server/session';
import { fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    assertFeature('auth');
    const state = crypto.randomUUID();
    // ?consent=1 forces a fresh consent screen (the "reconnect" path after a scope was
    // added); ?prompt=select_account lets the user pick a different account. Plain
    // sign-in stays clean (no prompt).
    const prompt = req.nextUrl.searchParams.get('consent')
      ? 'consent'
      : req.nextUrl.searchParams.get('prompt') === 'select_account'
      ? 'select_account'
      : undefined;
    const res = NextResponse.redirect(getAuthUrl(state, prompt));
    res.cookies.set(OAUTH_STATE_COOKIE, state, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
    });
    // ?flow=web marks a browser signup (the /get-started path). The callback uses it to
    // land the user in the app directly instead of via the Office dialog bridge, which
    // otherwise costs them a couple of seconds waiting for an Office.js probe to fail.
    // Absent → the add-in flow, which is the safe default.
    if (req.nextUrl.searchParams.get('flow') === 'web') {
      res.cookies.set(OAUTH_FLOW_COOKIE, 'web', {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: true,
        maxAge: 600,
      });
    }
    return res;
  } catch (error) {
    return fail(error);
  }
}
