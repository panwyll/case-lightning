import { NextRequest, NextResponse } from 'next/server';
import { assertFeature, config } from '@/lib/server/config';
import { SESSION_COOKIE, signSession } from '@/lib/server/session';
import { redeemSignInLink } from '@/lib/server/sign-in-links';
import { paths } from '@/lib/paths';
import { writeAudit } from '@/lib/server/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Redeem a one-time sign-in link and start the session (docs/sign-in.md).
 *
 * A person clicks this from their inbox, so both outcomes are a redirect to a page —
 * never JSON. A dead link lands back on sign-in with the reason shown.
 */
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token') ?? '';
  try {
    assertFeature('auth');
    const { userId, tenantId, next } = await redeemSignInLink(token);
    const session = await signSession(userId);
    const res = NextResponse.redirect(`${config.appUrl}${next}`);
    res.cookies.set(SESSION_COOKIE, session, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
      maxAge: 60 * 60 * 24 * 7,
    });
    // The audit row needs the firm; a link whose user has since been removed simply is not audited here.
    if (tenantId) await writeAudit({ tenantId, actorUserId: userId, actionType: 'SIGN_IN_LINK_REDEEMED', actionStatus: 'SUCCESS', payload: { next } }).catch(() => {});
    return res;
  } catch (error) {
    const why = error instanceof Error ? error.message : 'That sign-in link did not work.';
    return NextResponse.redirect(`${config.appUrl}${paths.signIn}?error=${encodeURIComponent(why)}`);
  }
}
