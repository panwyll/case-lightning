import { NextResponse } from 'next/server';
import { assertFeature, config } from '@/lib/server/config';
import { requireRole } from '@/lib/server/session';
import { fail } from '@/lib/server/http';
import { encryptSecret } from '@/lib/server/crypto';
import { LeapHttpClient } from '@/lib/server/integrations/leap/client';
import { leapClientConfig, pkceState } from '@/lib/server/integrations/leap/adapters';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LEAP_OAUTH_COOKIE = 'cl_leap_oauth';

/** Start the LEAP authorization-code flow (admins). State + PKCE verifier ride in an encrypted, short-lived cookie. */
export async function GET() {
  try {
    assertFeature('leap');
    const user = await requireRole(['ADMIN']);
    const { state, verifier, challenge } = pkceState();
    const url = LeapHttpClient.authorizeUrl(leapClientConfig(), state, challenge);
    const res = NextResponse.redirect(url, 302);
    res.cookies.set(LEAP_OAUTH_COOKIE, encryptSecret(JSON.stringify({ state, verifier, tenantId: user.tenantId, userId: user.userId, at: Date.now() })), { httpOnly: true, sameSite: 'lax', secure: config.appUrl.startsWith('https'), path: '/api/v1/integrations/leap', maxAge: 600 });
    return res;
  } catch (error) {
    return fail(error);
  }
}
