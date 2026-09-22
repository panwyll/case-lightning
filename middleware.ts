/**
 * The sign-in wall.
 *
 * Before this existed, an unauthenticated visitor to /cases got as far as rendering the
 * page, whose first API call came back 401, and the screen simply read "Unauthenticated"
 * with nowhere to go. A person who is not signed in should be asked to sign in.
 *
 * So the check happens here, at the edge, before anything renders: no valid session
 * cookie on a protected path → redirect to the sign-in page, remembering where they were
 * headed so they land there afterwards rather than on a generic home screen.
 *
 * This is a gate, not the authorisation: it only proves the cookie is a session this
 * server signed. Every route still loads the user and checks their role and their access
 * to the matter (requireUser / assertMatterAccess), and the database still enforces the
 * ethical wall. Middleware failing open would change nothing about what the API allows.
 */
import { NextRequest, NextResponse } from 'next/server';
import { jwtVerify } from 'jose';
import { isProtectedPath, paths } from './lib/paths';

const SESSION_COOKIE = 'cl_session';

async function hasValidSession(req: NextRequest): Promise<boolean> {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return false;
  const secret = process.env.SESSION_JWT_SECRET;
  // No secret configured (a preview build, say): treat every cookie as unproven rather
  // than waving everyone through. The API would reject them a moment later anyway.
  if (!secret) return false;
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret));
    return typeof payload.userId === 'string';
  } catch {
    return false; // expired, tampered with, or signed by another deployment
  }
}

export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  if (!isProtectedPath(pathname)) return NextResponse.next();
  if (await hasValidSession(req)) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = paths.signIn;
  url.search = '';
  url.searchParams.set('next', `${pathname}${search}`);
  return NextResponse.redirect(url);
}

export const config = {
  // Only the app's own pages. API routes answer 401 as they always did — a fetch wants a
  // status, not a redirect to HTML — and the client turns that into a trip to sign-in.
  matcher: ['/conveyi/:path*'],
};
