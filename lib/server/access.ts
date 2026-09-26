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

export type CaseAccessMode = 'open' | 'granted';
export type GrantKind = 'case' | 'cover' | 'mailbox';

export interface AccessGrant {
  id: string;
  granteeUserId: string;
  kind: GrantKind;
  matterId: string | null;
  subjectUserId: string | null;
  startsAt: string;
  endsAt: string | null;
  grantedBy: string | null;
  createdAt: string;
  // For display
  matterRef?: string | null;
  propertyAddress?: string | null;
  subjectName?: string | null;
  granteeName?: string | null;
}

export async function caseAccessMode(tenantId: string): Promise<CaseAccessMode> {
  const r = await queryOne<{ m: string | null }>(`select case_access_mode as m from policy_config where tenant_id = $1`, [tenantId]).catch(() => null);
  return r?.m === 'granted' ? 'granted' : 'open';
}

export async function setCaseAccessMode(tenantId: string, mode: CaseAccessMode, userId: string): Promise<void> {
  await query(
    `insert into policy_config (tenant_id, case_access_mode, updated_by, updated_at) values ($1, $2, $3, now())
     on conflict (tenant_id) do update set case_access_mode = excluded.case_access_mode, updated_by = excluded.updated_by, updated_at = now()`,
    [tenantId, mode, userId]
  );
}

const ACTIVE = `starts_at <= now() and (ends_at is null or ends_at > now())`;

/**
 * The matter ids this person may see, or null when unrestricted (an admin, or a
 * conveyancer in open mode). Lists filter by it; the guard checks one id against it.
 */
export async function visibleMatterIds(user: SessionUser): Promise<Set<string> | null> {
  if (user.role === 'ADMIN') return null;
  const assistant = user.role === 'ASSISTANT';
  if (!assistant && (await caseAccessMode(user.tenantId)) === 'open') return null;
  const rows = assistant
    ? await query<{ id: string }>(
        `select matter_id as id from access_grant where tenant_id = $1 and grantee_user_id = $2 and kind = 'case' and ${ACTIVE}`,
        [user.tenantId, user.userId]
      )
    : await query<{ id: string }>(
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

/** Mailboxes this person may work from: their own, plus any granted. */
export async function mailboxesFor(user: SessionUser): Promise<Array<{ userId: string; name: string; self: boolean }>> {
  const rows = await query<{ id: string; name: string }>(
    `select u.id, coalesce(u.display_name, u.email) as name from app_user u
      where u.tenant_id = $1 and (u.id = $2 or u.id in (
        select subject_user_id from access_grant where tenant_id = $1 and grantee_user_id = $2 and kind = 'mailbox' and ${ACTIVE}))
      order by (u.id = $2) desc, name`,
    [user.tenantId, user.userId]
  );
  return rows.map((r) => ({ userId: r.id, name: r.name, self: r.id === user.userId }));
}

/** The mailbox owner to act on: yourself, or a granted mailbox — anything else is a 403. */
export async function resolveMailbox(user: SessionUser, mailboxUserId: string | null | undefined): Promise<SessionUser> {
  if (!mailboxUserId || mailboxUserId === user.userId) return user;
  const allowed = (await mailboxesFor(user)).some((m) => m.userId === mailboxUserId);
  if (!allowed) throw Object.assign(new Error('You have not been granted that mailbox.'), { status: 403 });
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

export async function listGrants(tenantId: string): Promise<AccessGrant[]> {
  const rows = await query<Record<string, unknown>>(
    `select g.id, g.grantee_user_id, g.kind, g.matter_id, g.subject_user_id, g.starts_at, g.ends_at, g.granted_by, g.created_at,
            m.matter_ref, m.property_address,
            coalesce(s.display_name, s.email) as subject_name, coalesce(u.display_name, u.email) as grantee_name
       from access_grant g
       left join matter m on m.id = g.matter_id
       left join app_user s on s.id = g.subject_user_id
       left join app_user u on u.id = g.grantee_user_id
      where g.tenant_id = $1
      order by u.display_name, g.kind, g.created_at`,
    [tenantId]
  );
  return rows.map((r) => ({
    id: String(r.id),
    granteeUserId: String(r.grantee_user_id),
    kind: r.kind as GrantKind,
    matterId: (r.matter_id as string | null) ?? null,
    subjectUserId: (r.subject_user_id as string | null) ?? null,
    startsAt: String(r.starts_at),
    endsAt: (r.ends_at as string | null) ?? null,
    grantedBy: (r.granted_by as string | null) ?? null,
    createdAt: String(r.created_at),
    matterRef: (r.matter_ref as string | null) ?? null,
    propertyAddress: (r.property_address as string | null) ?? null,
    subjectName: (r.subject_name as string | null) ?? null,
    granteeName: (r.grantee_name as string | null) ?? null,
  }));
}

export async function addGrant(
  tenantId: string,
  grantedBy: string,
  input: { granteeUserId: string; kind: GrantKind; matterId?: string | null; subjectUserId?: string | null; endsAt?: string | null }
): Promise<string> {
  if (input.kind === 'case' && !input.matterId) throw Object.assign(new Error('Pick a case.'), { status: 400 });
  if (input.kind !== 'case' && !input.subjectUserId) throw Object.assign(new Error('Pick a colleague.'), { status: 400 });
  if (input.subjectUserId && input.subjectUserId === input.granteeUserId) throw Object.assign(new Error('Someone cannot be granted their own cases or mailbox.'), { status: 400 });
  const r = await queryOne<{ id: string }>(
    `insert into access_grant (tenant_id, grantee_user_id, kind, matter_id, subject_user_id, ends_at, granted_by)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict do nothing
     returning id`,
    [tenantId, input.granteeUserId, input.kind, input.matterId ?? null, input.subjectUserId ?? null, input.endsAt ?? null, grantedBy]
  );
  return r?.id ?? '';
}

export async function removeGrant(tenantId: string, id: string): Promise<void> {
  await query(`delete from access_grant where tenant_id = $1 and id = $2`, [tenantId, id]);
}
