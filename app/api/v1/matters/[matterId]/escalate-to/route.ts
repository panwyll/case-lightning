import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertMatterAccess } from '@/lib/server/guard';
import { ok, fail } from '@/lib/server/http';
import { query } from '@/lib/server/db';
import { canAccessMatter } from '@/lib/server/access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Who a decision on this case can be escalated to: colleagues (not the person escalating) who can open the case. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ matterId: string }> }) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const { matterId } = z.object({ matterId: z.string().uuid() }).parse(await params);
    await assertMatterAccess(user, matterId);
    const team = await query<{ id: string; name: string; role: string; job_title: string | null; case_access: string | null; mailbox_access: string | null }>(
      `select id, coalesce(nullif(display_name, ''), email) as name, role, job_title, case_access, mailbox_access from app_user where tenant_id = $1 and id <> $2 order by (role = 'ADMIN') desc, name`,
      [user.tenantId, user.userId]
    );
    const people = [];
    for (const p of team) {
      const can = await canAccessMatter({ ...user, userId: p.id, role: p.role, caseAccess: p.case_access ?? undefined, mailboxAccess: p.mailbox_access ?? undefined } as never, matterId).catch(() => false);
      if (can && p.role !== 'ASSISTANT') people.push({ id: p.id, name: p.name, title: p.job_title ?? (p.role === 'ADMIN' ? 'Admin' : null) });
    }
    return ok({ people });
  } catch (error) {
    return fail(error);
  }
}
