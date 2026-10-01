import { NextRequest, NextResponse } from 'next/server';
import { config } from '@/lib/server/config';
import { queryOne } from '@/lib/server/db';
import { SESSION_COOKIE, signSession } from '@/lib/server/session';
import { paths } from '@/lib/paths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Local development only: sign in as someone in the local demo firm (scripts/dev-db.sh) without Microsoft or an
 * emailed link. ?as=email picks the person (default: the admin); ?next= where to land. Does not exist in production
 * or against any database that is not on this machine.
 */
export async function GET(req: NextRequest) {
  const local = /localhost|127\.0\.0\.1/.test(config.databaseUrl ?? '');
  if (process.env.NODE_ENV !== 'development' || !local) return new NextResponse('Not found.', { status: 404 });
  const as = req.nextUrl.searchParams.get('as');
  const user = await queryOne<{ id: string }>(
    as ? `select id from app_user where lower(email) = lower($1)` : `select u.id from app_user u join tenant t on t.id = u.tenant_id where t.name = 'Anwyll & Co (Demo)' and u.role = 'ADMIN' limit 1`,
    as ? [as] : []
  );
  if (!user) return new NextResponse('No such person in the local database. Run npm run dev:db first.', { status: 404 });
  const next = req.nextUrl.searchParams.get('next') ?? paths.tasks;
  const res = NextResponse.redirect(new URL(next.startsWith('/') ? next : paths.tasks, req.nextUrl.origin));
  res.cookies.set(SESSION_COOKIE, await signSession(user.id), { path: '/', httpOnly: true, sameSite: 'lax', secure: false, maxAge: 60 * 60 * 24 * 7 });
  return res;
}
