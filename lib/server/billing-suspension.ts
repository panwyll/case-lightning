/**
 * A firm that has not paid past its grace period is suspended: its people can still sign in
 * and read their cases, but nothing is sent, nothing is read by AI and no chase goes. Mail that
 * arrives meanwhile is held, not dropped; the moment they pay it is processed, and the engine's
 * next sweep sends whatever chases fell due, so they pick up where they left off.
 */
import { query, queryOne } from './db';
import { isEntitled } from './plan';
import type { SessionUser } from './types';

export async function holdMail(tenantId: string, userId: string, messageId: string): Promise<void> {
  await query(`insert into held_mail (tenant_id, user_id, message_id) values ($1, $2, $3) on conflict do nothing`, [tenantId, userId, messageId]).catch((e) => console.warn('[billing] could not hold mail', (e as Error).message));
}

/** Process mail held while the firm was suspended (oldest first), once they are entitled again. */
export async function releaseHeldMail(tenantId: string, limit = 200): Promise<{ released: number; failed: number }> {
  if (!(await isEntitled(tenantId))) return { released: 0, failed: 0 };
  const rows = await query<{ id: string; user_id: string; message_id: string }>(`select id, user_id, message_id from held_mail where tenant_id = $1 order by received_at limit $2`, [tenantId, limit]).catch(() => []);
  if (!rows.length) return { released: 0, failed: 0 };
  const { processIncomingMessage } = await import('./mail/incoming');
  let released = 0, failed = 0;
  for (const r of rows) {
    const user = await queryOne<SessionUser>(`select id as "userId", tenant_id as "tenantId", role, email, display_name as "displayName" from app_user where id = $1 and tenant_id = $2`, [r.user_id, tenantId]).catch(() => null);
    try {
      if (user) await processIncomingMessage(user, r.message_id);
      released += 1;
    } catch (err) {
      // A message since deleted from the mailbox cannot be read: it is let go, not retried for ever.
      failed += 1;
      console.warn('[billing] held mail could not be processed', r.message_id, (err as Error).message);
    }
    await query(`delete from held_mail where id = $1`, [r.id]).catch(() => {});
  }
  return { released, failed };
}

/** Every firm with held mail that can now have it: for the daily sweep, in case a resume was missed. */
export async function releaseAllHeldMail(): Promise<number> {
  const tenants = await query<{ tenant_id: string }>(`select distinct tenant_id from held_mail`).catch(() => []);
  let n = 0;
  for (const t of tenants) n += (await releaseHeldMail(t.tenant_id).catch(() => ({ released: 0 }))).released;
  return n;
}
