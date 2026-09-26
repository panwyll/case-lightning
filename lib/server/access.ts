/**
 * Who may see what inside a firm (migration 086).
 *
 *   Admin        — every case, every mailbox they are granted (their own always).
 *   Conveyancer  — in 'open' mode every case; in 'granted' mode the cases they handle,
 *                  cases granted to them, and every case of anyone they are covering.
 *   Assistant    — only cases granted to them (a filing they made grants the case), and
 *                  only mailboxes granted to them. Either mode.
 *   Read only    — as a conveyancer, without the writes the role already blocks.
 *
 * Grants are rows a firm admin adds and removes on the Team tab; every change is audited
 * by the route. A covering conveyancer acts as themselves.
 */
import { query, queryOne } from './db';
import type { SessionUser } from './types';

export type GrantKind = 'case' | 'cover' | 'mailbox';
export type CaseAccess = 'all' | 'selected';
export type MailboxAccess = 'own' | 'all' | 'selected';

export interface PersonAccess {
  caseAccess: CaseAccess;
  mailboxAccess: MailboxAccess;
  /** Colleagues whose cases they may see (when selected). */
  covers: string[];
  /** Colleagues whose mailboxes they may file from (when selected). */
  mailboxes: string[];
}

const ACTIVE = `starts_at <= now() and (ends_at is null or ends_at > now())`;

async function accessOf(user: SessionUser): Promise<{ caseAccess: CaseAccess; mailboxAccess: MailboxAccess }> {
  if (user.caseAccess && user.mailboxAccess) return { caseAccess: user.caseAccess, mailboxAccess: user.mailboxAccess };
  const r = await queryOne<{ case_access: CaseAccess; mailbox_access: MailboxAccess }>(`select case_access, mailbox_access from app_user where id = $1`, [user.userId]).catch(() => null);
  return { caseAccess: r?.case_access ?? 'all', mailboxAccess: r?.mailbox_access ?? 'own' };
}

/**
 * The matter ids this person may see, or null when unrestricted (an admin, or anyone on
 * "all cases"). Lists filter by it; the guard checks one id against it.
 */
export async function visibleMatterIds(user: SessionUser): Promise<Set<string> | null> {
  if (user.role === 'ADMIN') return null;
  if ((await accessOf(user)).caseAccess === 'all') return null;
  const rows = await query<{ id: string }>(
    `select id from matter where tenant_id = $1 and (assigned_to = $2 or (assigned_to is null and created_by = $2))
     union
     select matter_id from access_grant where tenant_id = $1 and grantee_user_id = $2 and kind = 'case' and ${ACTIVE}
     union
     select m.id from access_grant g join matter m on m.tenant_id = g.tenant_id and (m.assigned_to = g.subject_user_id or (m.assigned_to is null and m.created_by = g.subject_user_id))
      where g.tenant_id = $1 and g.grantee_user_id = $2 and g.kind = 'cover' and g.${ACTIVE}`,
    [user.tenantId, user.userId]
  );
  return new Set(rows.map((r) => r.id));
}

export async function canAccessMatter(user: SessionUser, matterId: string): Promise<boolean> {
  const ids = await visibleMatterIds(user);
  return ids === null || ids.has(matterId);
}

/** Keep only the rows this person may see. */
export async function onlyVisible<T extends { matterId: string }>(user: SessionUser, rows: T[]): Promise<T[]> {
  const ids = await visibleMatterIds(user);
  return ids === null ? rows : rows.filter((r) => ids.has(r.matterId));
}

/** Mailboxes this person may work from: their own, plus all or the selected colleagues'. */
export async function mailboxesFor(user: SessionUser): Promise<Array<{ userId: string; name: string; self: boolean }>> {
  const { mailboxAccess } = await accessOf(user);
  const rows =
    mailboxAccess === 'all'
      ? await query<{ id: string; name: string }>(`select id, coalesce(display_name, email) as name from app_user where tenant_id = $1 order by (id = $2) desc, name`, [user.tenantId, user.userId])
      : mailboxAccess === 'selected'
        ? await query<{ id: string; name: string }>(
            `select u.id, coalesce(u.display_name, u.email) as name from app_user u
              where u.tenant_id = $1 and (u.id = $2 or u.id in (
                select subject_user_id from access_grant where tenant_id = $1 and grantee_user_id = $2 and kind = 'mailbox' and ${ACTIVE}))
              order by (u.id = $2) desc, name`,
            [user.tenantId, user.userId]
          )
        : await query<{ id: string; name: string }>(`select id, coalesce(display_name, email) as name from app_user where id = $1`, [user.userId]);
  return rows.map((r) => ({ userId: r.id, name: r.name, self: r.id === user.userId }));
}

/** The mailbox owner to act on: yourself, or a colleague's you may file from — anything else is a 403. */
export async function resolveMailbox(user: SessionUser, mailboxUserId: string | null | undefined): Promise<SessionUser> {
  if (!mailboxUserId || mailboxUserId === user.userId) return user;
  const allowed = (await mailboxesFor(user)).some((m) => m.userId === mailboxUserId);
  if (!allowed) throw Object.assign(new Error('You have not been given that mailbox.'), { status: 403 });
  const owner = await queryOne<SessionUser>(
    `select id as "userId", tenant_id as "tenantId", role, email, display_name as "displayName" from app_user where id = $1 and tenant_id = $2`,
    [mailboxUserId, user.tenantId]
  );
  if (!owner) throw Object.assign(new Error('Mailbox not found.'), { status: 404 });
  return owner;
}

/** An assistant who files an email to a case can then see that case. Idempotent. */
export async function grantCaseIfAssistant(user: SessionUser, matterId: string): Promise<void> {
  if (user.role !== 'ASSISTANT') return;
  await query(
    `insert into access_grant (tenant_id, grantee_user_id, kind, matter_id, granted_by) values ($1, $2, 'case', $3, $2)
     on conflict do nothing`,
    [user.tenantId, user.userId, matterId]
  ).catch(() => {});
}

/** One person's access as the Team tab edits it. */
export async function getPersonAccess(tenantId: string, userId: string): Promise<PersonAccess> {
  const u = await queryOne<{ case_access: CaseAccess; mailbox_access: MailboxAccess }>(`select case_access, mailbox_access from app_user where id = $1 and tenant_id = $2`, [userId, tenantId]);
  if (!u) throw Object.assign(new Error('Colleague not found.'), { status: 404 });
  const g = await query<{ kind: string; subject_user_id: string }>(`select kind, subject_user_id from access_grant where tenant_id = $1 and grantee_user_id = $2 and kind in ('cover', 'mailbox') and ${ACTIVE}`, [tenantId, userId]);
  return {
    caseAccess: u.case_access,
    mailboxAccess: u.mailbox_access,
    covers: g.filter((x) => x.kind === 'cover').map((x) => x.subject_user_id),
    mailboxes: g.filter((x) => x.kind === 'mailbox').map((x) => x.subject_user_id),
  };
}

/** Replace one person's access wholesale: the two modes and the colleague lists behind "selected". */
export async function setPersonAccess(tenantId: string, userId: string, grantedBy: string, a: PersonAccess): Promise<void> {
  await query(`update app_user set case_access = $3, mailbox_access = $4 where id = $1 and tenant_id = $2`, [userId, tenantId, a.caseAccess, a.mailboxAccess]);
  await query(`delete from access_grant where tenant_id = $1 and grantee_user_id = $2 and kind in ('cover', 'mailbox')`, [tenantId, userId]);
  const want: Array<[GrantKind, string]> = [
    ...(a.caseAccess === 'selected' ? a.covers.filter((s) => s !== userId).map((s): [GrantKind, string] => ['cover', s]) : []),
    ...(a.mailboxAccess === 'selected' ? a.mailboxes.filter((s) => s !== userId).map((s): [GrantKind, string] => ['mailbox', s]) : []),
  ];
  for (const [kind, subject] of want) {
    await query(`insert into access_grant (tenant_id, grantee_user_id, kind, subject_user_id, granted_by) values ($1, $2, $3, $4, $5) on conflict do nothing`, [tenantId, userId, kind, subject, grantedBy]);
  }
}
