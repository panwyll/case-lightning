import { NextRequest } from 'next/server';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { assertFeature, config } from '@/lib/server/config';
import { requireRole } from '@/lib/server/session';
import { query, queryOne } from '@/lib/server/db';
import { writeAudit } from '@/lib/server/audit';
import { setPersonAccess } from '@/lib/server/access';
import { requestSignInLink } from '@/lib/server/sign-in-links';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    const users = await query(
      `select id, email, display_name, role, created_at, case_access, mailbox_access,
              (entra_object_id not like 'pending:%') as signed_in
         from app_user where tenant_id = $1 order by created_at asc`,
      [user.tenantId]
    );
    return ok({ users });
  } catch (error) {
    return fail(error);
  }
}

/**
 * Add a colleague. The account exists from this moment — name, role, access all set — and
 * they get a sign-in link. Their first Microsoft sign-in claims the account by email.
 */
export async function POST(req: NextRequest) {
  try {
    assertFeature('auth');
    const admin = await requireRole(['ADMIN']);
    const input = z
      .object({
        name: z.string().trim().min(1).max(140),
        email: z.string().trim().email().max(320),
        role: z.enum(['ADMIN', 'CONVEYANCER', 'ASSISTANT', 'READ_ONLY']),
        caseAccess: z.enum(['all', 'selected']),
        mailboxAccess: z.enum(['own', 'all', 'selected']),
        covers: z.array(z.string().uuid()).max(200).default([]),
        mailboxes: z.array(z.string().uuid()).max(200).default([]),
      })
      .parse(await req.json());
    const email = input.email.toLowerCase();
    const n = await queryOne<{ n: string }>(`select count(*)::text as n from app_user where tenant_id = $1`, [admin.tenantId]);
    if (Number(n?.n ?? '0') >= config.teamMaxMembers) throw Object.assign(new Error(`Your team is at its limit of ${config.teamMaxMembers} people.`), { status: 409 });
    const dup = await queryOne<{ id: string }>(`select id from app_user where tenant_id = $1 and lower(email) = $2`, [admin.tenantId, email]);
    if (dup) throw Object.assign(new Error('That person is already on the team.'), { status: 409 });
    const row = await queryOne<{ id: string }>(
      `insert into app_user (tenant_id, entra_object_id, email, display_name, role, case_access, mailbox_access)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [admin.tenantId, `pending:${randomUUID()}`, email, input.name, input.role, input.caseAccess, input.mailboxAccess]
    );
    const userId = row!.id;
    await setPersonAccess(admin.tenantId, userId, admin.userId, { caseAccess: input.caseAccess, mailboxAccess: input.mailboxAccess, covers: input.covers, mailboxes: input.mailboxes });
    await writeAudit({ tenantId: admin.tenantId, actorUserId: admin.userId, actionType: 'USER_CREATED', actionStatus: 'SUCCESS', payload: { userId, email, role: input.role } }).catch(() => {});
    // Best-effort: the link is how they get in; if mail is not configured the account still exists.
    const link = await requestSignInLink(email, { next: '/conveyi/cases' }).catch(() => null);
    return ok({ userId, signInLinkSent: !!link });
  } catch (error) {
    return fail(error);
  }
}
