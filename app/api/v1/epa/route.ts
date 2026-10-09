import { NextRequest } from 'next/server';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { queryOne } from '@/lib/server/db';
import { epaReport, firmPeople } from '@/lib/server/epa/store';
import { EPA_SPEC } from '@/lib/server/epa/taxonomy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The Efficiency page (docs/epa.md §3): a person's own figures; an admin may look at anyone's at the firm. */
export async function GET(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const asked = req.nextUrl.searchParams.get('person');
    const weeks = Math.max(2, Math.min(26, Number(req.nextUrl.searchParams.get('weeks')) || 8));
    let person = { userId: user.userId, name: user.displayName ?? user.email };
    if (asked && asked !== user.userId) {
      if (user.role !== 'ADMIN') throw Object.assign(new Error('Only an admin can see another person’s figures.'), { status: 403 });
      const p = await queryOne<{ id: string; name: string }>(`select id, coalesce(display_name, email) as name from app_user where id = $1 and tenant_id = $2`, [asked, user.tenantId]);
      if (!p) throw Object.assign(new Error('No such person at the firm.'), { status: 404 });
      person = { userId: p.id, name: p.name };
    }
    const report = await epaReport(user.tenantId, person.userId, weeks);
    return ok({ person, isOwn: person.userId === user.userId, admin: user.role === 'ADMIN', people: user.role === 'ADMIN' ? await firmPeople(user.tenantId) : null, report, spec: EPA_SPEC });
  } catch (e) {
    return fail(e);
  }
}
