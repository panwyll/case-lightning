import { NextRequest } from 'next/server';
import { paths } from '@/lib/paths';
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
      // Developer accounts (135) are labelled; anyone whose access was removed is gone.
      `select u.id, u.email, u.display_name, u.role, u.created_at, u.case_access, u.mailbox_access, u.is_developer,
              (u.entra_object_id not like 'pending:%' and u.entra_object_id not like 'developer:%') or exists (select 1 from sign_in_link l where l.user_id = u.id and l.used_at is not null) as signed_in,
              coalesce(a.display_name, a.email) as added_by_name
         from app_user u left join app_user a on a.id = u.added_by
        where u.tenant_id = $1 and u.access_removed_at is null order by u.is_developer, u.created_at asc`,
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
 *
 * Role DEVELOPER adds a developer account for setting the firm up (migration 135): an
 * admin account flagged is_developer — admin privileges, labelled, never a handler, not
 * counted against the team limit, removable in one step. Only the firm's own admins add
 * one; a developer cannot bring in others.
 */
export async function POST(req: NextRequest) {
  try {
    assertFeature('auth');
    const admin = await requireRole(['ADMIN']);
    const input = z
      .object({
        name: z.string().trim().min(1).max(140),
        email: z.string().trim().email().max(320),
        role: z.enum(['ADMIN', 'CONVEYANCER', 'ASSISTANT', 'DEVELOPER']),
        caseAccess: z.enum(['all', 'selected']),
        mailboxAccess: z.enum(['own', 'all', 'selected']),
        covers: z.array(z.string().uuid()).max(200).default([]),
        mailboxes: z.array(z.string().uuid()).max(200).default([]),
      })
      .parse(await req.json());
    const email = input.email.toLowerCase();
    const developer = input.role === 'DEVELOPER';
    if (developer && admin.isDeveloper) throw Object.assign(new Error("Only one of the firm's own admins can add a developer."), { status: 403 });
    if (!developer) {
      const n = await queryOne<{ n: string }>(`select count(*)::text as n from app_user where tenant_id = $1 and not is_developer and access_removed_at is null`, [admin.tenantId]);
      if (Number(n?.n ?? '0') >= config.teamMaxMembers) throw Object.assign(new Error(`Your team is at its limit of ${config.teamMaxMembers} people.`), { status: 409 });
    }
    const dup = await queryOne<{ id: string; is_developer: boolean; removed: boolean }>(
      `select id, is_developer, access_removed_at is not null as removed from app_user where tenant_id = $1 and lower(email) = $2`,
      [admin.tenantId, email]
    );
    if (dup && !(developer && dup.removed)) throw Object.assign(new Error(dup.removed ? 'That address had access removed. Add them as a developer, or contact support.' : 'That person is already on the team.'), { status: 409 });
    // A developer whose access was removed is let back in on the same account, so what
    // they did before stays attributed to them.
    const row = developer
      ? dup
        ? await queryOne<{ id: string }>(
            `update app_user set role = 'ADMIN', is_developer = true, display_name = $3, added_by = $4, access_removed_at = null, access_removed_by = null, case_access = $5, mailbox_access = $6
              where id = $1 and tenant_id = $2 returning id`,
            [dup.id, admin.tenantId, input.name, admin.userId, input.caseAccess, input.mailboxAccess]
          )
        : await queryOne<{ id: string }>(
            `insert into app_user (tenant_id, entra_object_id, email, display_name, role, case_access, mailbox_access, is_developer, added_by)
             values ($1, $2, $3, $4, 'ADMIN', $5, $6, true, $7) returning id`,
            [admin.tenantId, `developer:${randomUUID()}`, email, input.name, input.caseAccess, input.mailboxAccess, admin.userId]
          )
      : await queryOne<{ id: string }>(
          `insert into app_user (tenant_id, entra_object_id, email, display_name, role, case_access, mailbox_access)
           values ($1, $2, $3, $4, $5, $6, $7) returning id`,
          [admin.tenantId, `pending:${randomUUID()}`, email, input.name, input.role, input.caseAccess, input.mailboxAccess]
        );
    const userId = row!.id;
    await setPersonAccess(admin.tenantId, userId, admin.userId, { caseAccess: input.caseAccess, mailboxAccess: input.mailboxAccess, covers: input.covers, mailboxes: input.mailboxes });
    await writeAudit({ tenantId: admin.tenantId, actorUserId: admin.userId, actionType: developer ? 'DEVELOPER_ADDED' : 'USER_CREATED', actionStatus: 'SUCCESS', payload: { userId, email, role: input.role } }).catch(() => {});
    // Best-effort: the link is how they get in; if mail is not configured the account still exists.
    const link = await requestSignInLink(email, { next: paths.matters }).catch(() => null);
    return ok({ userId, signInLinkSent: !!link });
  } catch (error) {
    return fail(error);
  }
}
