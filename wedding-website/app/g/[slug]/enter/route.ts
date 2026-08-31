import { NextResponse } from 'next/server';
import { COOKIE, cookieOptions, createToken, verifyGuestCode } from '@/lib/auth';
import { getGuest } from '@/lib/guests';

export const runtime = 'nodejs';

/**
 * Exchanges a personal access code for a session cookie, then sends the guest
 * on to a clean URL — so the code stops travelling in referrers, browser
 * history and shoulder-surfing range.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const code = new URL(request.url).searchParams.get('k');
  const guest = getGuest(slug);

  const destination = new URL(`/g/${encodeURIComponent(slug)}`, request.url);

  if (!guest || !(await verifyGuestCode(slug, code, guest.accessCode))) {
    destination.searchParams.set('bad', '1');
    return NextResponse.redirect(destination);
  }

  const response = NextResponse.redirect(destination);
  const token = await createToken({ kind: 'guest', slug });
  response.cookies.set(COOKIE.guest, token, cookieOptions);
  // A valid personal link is also a way into the shared site.
  response.cookies.set(COOKIE.site, await createToken({ kind: 'site' }), cookieOptions);
  return response;
}
