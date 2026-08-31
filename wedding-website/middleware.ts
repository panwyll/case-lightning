import { NextResponse, type NextRequest } from 'next/server';
import { COOKIE, readToken } from '@/lib/auth';

/**
 * The front door. Everything is private by default:
 *
 *   /g/*        — personal guest pages, which check their own access code.
 *   /login      — the shared password prompt.
 *   /admin/*    — requires the admin cookie.
 *   everything  — requires any valid session.
 */

const ALWAYS_OPEN = ['/login', '/admin/login', '/api/auth/', '/robots.txt', '/favicon.ico'];

export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  if (ALWAYS_OPEN.some((p) => pathname === p || pathname.startsWith(p))) {
    return NextResponse.next();
  }

  const cookies = request.cookies;
  const admin = await readToken(cookies.get(COOKIE.admin)?.value);

  if (pathname === '/admin' || pathname.startsWith('/admin/')) {
    if (admin?.kind === 'admin') return NextResponse.next();
    return redirectTo(request, '/admin/login', pathname + search);
  }

  // Personal pages carry their own credential in the query string, and the
  // page itself decides. Letting them past here means a guest who follows
  // their link never meets the shared password prompt.
  if (pathname.startsWith('/g/')) return NextResponse.next();

  if (admin?.kind === 'admin') return NextResponse.next();

  const site = await readToken(cookies.get(COOKIE.site)?.value);
  if (site?.kind === 'site') return NextResponse.next();

  const guest = await readToken(cookies.get(COOKIE.guest)?.value);
  if (guest?.kind === 'guest') return NextResponse.next();

  return redirectTo(request, '/login', pathname + search);
}

function redirectTo(request: NextRequest, to: string, next: string) {
  const url = request.nextUrl.clone();
  url.pathname = to;
  url.search = next && next !== '/' ? `?next=${encodeURIComponent(next)}` : '';
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|assets/|images/).*)'],
};
