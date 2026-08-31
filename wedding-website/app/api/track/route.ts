import { NextResponse } from 'next/server';
import { store } from '@/lib/store';
import { currentSessions } from '@/lib/session';

export const runtime = 'nodejs';

/**
 * Best-effort visit log. Only records a slug the caller actually holds a
 * session for, so nobody can inflate someone else's numbers.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    slug?: string | null;
    path?: string;
    referrer?: string;
  };

  const { admin, site, guestSlug } = await currentSessions();
  if (!admin && !site && !guestSlug) return NextResponse.json({ ok: false }, { status: 401 });

  // Admin previews would otherwise pollute the guest's own view count.
  if (admin) return NextResponse.json({ ok: true, skipped: 'admin' });

  const slug = typeof body.slug === 'string' && body.slug === guestSlug ? guestSlug : null;
  const path = typeof body.path === 'string' ? body.path.slice(0, 300) : '/';

  try {
    await store().recordVisit({
      slug,
      path,
      referrer: typeof body.referrer === 'string' ? body.referrer.slice(0, 300) : undefined,
      at: new Date().toISOString(),
    });
  } catch {
    // Never fail a page view because monitoring is down.
    return NextResponse.json({ ok: false });
  }

  return NextResponse.json({ ok: true });
}
