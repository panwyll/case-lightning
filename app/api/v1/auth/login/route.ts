import { NextResponse } from 'next/server';
import { assertFeature } from '@/lib/server/config';
import { getAuthUrl } from '@/lib/server/oauth';
import { OAUTH_STATE_COOKIE } from '@/lib/server/session';
import { fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    assertFeature('auth');
    const state = crypto.randomUUID();
    const res = NextResponse.redirect(getAuthUrl(state));
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
