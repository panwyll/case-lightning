import { NextResponse } from 'next/server';
import { COOKIE, checkAdminPassword, cookieOptions, createToken } from '@/lib/auth';
import { safeNext } from '@/lib/redirect';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { password?: string; next?: string };
  const password = typeof body.password === 'string' ? body.password : '';

  if (!checkAdminPassword(password)) {
    await new Promise((r) => setTimeout(r, 600));
    return NextResponse.json({ error: 'Nope.' }, { status: 401 });
  }

  const response = NextResponse.json({ redirect: safeNext(body.next, '/admin') });
  const token = await createToken({ kind: 'admin' });
  response.cookies.set(COOKIE.admin, token, cookieOptions);
  // An admin is also a site visitor, so pages outside /admin work straight away.
  response.cookies.set(COOKIE.site, await createToken({ kind: 'site' }), cookieOptions);
  return response;
}
