/**
 * Token-based team invites. An admin invites a colleague by email; we email them a link and
 * pre-authorise their role. Because a firm == a Microsoft tenant here, the colleague joins by
 * signing in with their same-org account (the OAuth callback auto-adds them) — the invite lets
 * us (a) email them the link, (b) set their role on join by matching the address, and (c) track
 * pending/accepted. Seat billing still applies (Firm plan for >1 seat).
 */
import { randomUUID } from 'crypto';
import { query, queryOne } from './db';
import { sendMail } from './graph';
import { config } from './config';
import type { SessionUser } from './types';

export interface TeamInvite {
  id: string;
  email: string;
  role: string;
  status: string;
  created_at: string;
  accepted_at: string | null;
}

const ROLES = ['ADMIN', 'CONVEYANCER', 'ASSISTANT'];

export async function listInvites(tenantId: string): Promise<TeamInvite[]> {
  return query<TeamInvite>(
    `select id, email, role, status, created_at, accepted_at
       from team_invite where tenant_id = $1 order by created_at desc`,
    [tenantId]
  ).catch(() => []);
}

/** Create (or refresh) an invite and email the colleague a sign-in link. */
export async function createInvite(user: SessionUser, emailRaw: string, roleRaw: string, firmName: string): Promise<TeamInvite> {
  const email = emailRaw.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Enter a valid email address.');
  const role = ROLES.includes(roleRaw) ? roleRaw : 'CONVEYANCER';

  // Already a member?
  const member = await queryOne<{ id: string }>(`select id from app_user where tenant_id = $1 and lower(email) = $2`, [user.tenantId, email]).catch(() => null);
  if (member) throw new Error('That person is already on your team.');

  const token = randomUUID().replace(/-/g, '');
  // Re-inviting the same address replaces the pending row (unique partial index).
  const row = await queryOne<TeamInvite>(
    `insert into team_invite (tenant_id, email, role, token, invited_by)
     values ($1,$2,$3,$4,$5)
     on conflict (tenant_id, lower(email)) where (status = 'PENDING')
     do update set role = excluded.role, token = excluded.token, invited_by = excluded.invited_by, created_at = now()
     returning id, email, role, status, created_at, accepted_at`,
    [user.tenantId, email, role, token, user.userId]
  );
  if (!row) throw new Error('Could not create the invite.');

  // Email the link — best-effort so a mail hiccup never loses the invite row.
  const link = `${config.appUrl}/admin?invite=${token}`;
  const inviter = user.displayName || user.email || 'A colleague';
  const html = `
    <p>${escapeHtml(inviter)} has invited you to join <strong>${escapeHtml(firmName)}</strong> on Case Lightning as ${roleLabel(role)}.</p>
    <p>Sign in with your work Microsoft account to get started:</p>
    <p><a href="${link}" style="display:inline-block;padding:10px 18px;background:#5A27E0;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Join ${escapeHtml(firmName)}</a></p>
    <p style="color:#64748b;font-size:13px">If the button doesn’t work, paste this link into your browser:<br>${link}</p>`;
  try {
    await sendMail(user.userId, email, `You’re invited to ${firmName} on Case Lightning`, html);
  } catch { /* invite persists even if the email couldn't be sent — the admin can copy the link */ }
  return row;
}

export async function revokeInvite(tenantId: string, id: string): Promise<void> {
  await query(`update team_invite set status = 'REVOKED' where id = $1 and tenant_id = $2 and status = 'PENDING'`, [id, tenantId]);
}

/**
 * Called from the OAuth callback after a user is upserted: if a pending invite matches this
 * address in this firm, apply the invited role and mark the invite accepted. Safe to call for
 * every sign-in (no-op when there's no matching invite).
 */
export async function applyInviteOnJoin(tenantId: string, userId: string, email: string): Promise<void> {
  try {
    const inv = await queryOne<{ id: string; role: string }>(
      `select id, role from team_invite where tenant_id = $1 and lower(email) = lower($2) and status = 'PENDING' limit 1`,
      [tenantId, email]
    );
    if (!inv) return;
    if (ROLES.includes(inv.role)) {
      await query(`update app_user set role = $3 where id = $1 and tenant_id = $2`, [userId, tenantId, inv.role]);
    }
    await query(`update team_invite set status = 'ACCEPTED', accepted_at = now(), accepted_user_id = $3 where id = $1 and tenant_id = $2`, [inv.id, tenantId, userId]);
  } catch { /* best-effort — never block sign-in on invite bookkeeping */ }
}

function roleLabel(r: string) { return r === 'ADMIN' ? 'an administrator' : r === 'ASSISTANT' ? 'an assistant' : 'a conveyancer'; }
function escapeHtml(s: string) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
