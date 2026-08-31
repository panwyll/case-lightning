import { NextResponse } from 'next/server';
import { COOKIE, checkSitePassword, cookieOptions, createToken } from '@/lib/auth';
import { safeNext } from '@/lib/redirect';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { password?: string; next?: string };
  const password = typeof body.password === 'string' ? body.password : '';

  if (!checkSitePassword(password)) {
    // Deliberately vague, and slow enough to make guessing tedious.
    await new Promise((r) => setTimeout(r, 400));
    return NextResponse.json({ error: 'That is not the password on the invitation.' }, { status: 401 });
  }

  const response = NextResponse.json({ redirect: safeNext(body.next) });
  response.cookies.set(COOKIE.site, await createToken({ kind: 'site' }), cookieOptions);
  return response;
}
