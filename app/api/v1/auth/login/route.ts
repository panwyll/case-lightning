import { NextRequest, NextResponse } from 'next/server';
import { assertFeature } from '@/lib/server/config';
import { getAuthUrl } from '@/lib/server/oauth';
import { OAUTH_STATE_COOKIE } from '@/lib/server/session';
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
    return res;
  } catch (error) {
    return fail(error);
  }
}
