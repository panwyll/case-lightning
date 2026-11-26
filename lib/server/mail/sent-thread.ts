/**
 * A conversation the fee earner wrote on for a case goes on that case, as filing it on the Email tab would: its replies
 * then file themselves (a trusted link), and what was already waiting in their filing queue from it is filed now, so
 * nobody files the same thread twice. A conversation already on a case is left as it is. A queued email whose sender
 * check found something wrong, or a forward, stays in the queue for a person.
 */
import { query, queryOne } from '../db';
import { getMessage } from '../graph';
import { isForwarded } from '../matching';
import { autoFileToCase } from './auto-file';
import type { SessionUser } from '../types';

export async function fileThreadOfSentEmail(user: SessionUser, matterId: string, message: any): Promise<{ linked: boolean; filed: number }> {
  const conversationId: string | null = message?.conversationId ?? null;
  if (!conversationId) return { linked: false, filed: 0 };
  const onCase = await queryOne<{ matter_id: string }>(`select matter_id from email_thread where tenant_id = $1 and graph_conversation_id = $2 limit 1`, [user.tenantId, conversationId]).catch(() => null);
  if (onCase) return { linked: false, filed: 0 };
  const ref = (await queryOne<{ matter_ref: string }>(`select matter_ref from matter where id = $1 and tenant_id = $2`, [matterId, user.tenantId]).catch(() => null))?.matter_ref ?? null;
  const linked = await queryOne<{ id: string }>(
    `insert into email_thread (tenant_id, matter_id, graph_thread_id, graph_conversation_id, subject, participants, outlook_category)
     values ($1,$2,$3,$3,$4,'[]'::jsonb,$5) on conflict (tenant_id, graph_thread_id) do nothing returning id`,
    [user.tenantId, matterId, conversationId, message?.subject ?? null, ref]
  ).catch(() => null);
  if (!linked) return { linked: false, filed: 0 };
  // What was waiting to be filed from this conversation, in this mailbox: filed as the person would have filed it.
  const waiting = await query<{ graph_message_id: string; sender: { verdict?: string } | null }>(
    `select graph_message_id, sender from email_queue where tenant_id = $1 and graph_conversation_id = $2 and mailbox_user_id = $3 and resolved_at is null`,
    [user.tenantId, conversationId, user.userId]
  ).catch(() => []);
  let filed = 0;
  for (const row of waiting) {
    if (row.sender?.verdict === 'suspicious') continue;
    const m = await getMessage(user.userId, row.graph_message_id).catch(() => null);
    if (!m || isForwarded(m)) continue;
    await autoFileToCase(user, m, matterId).catch((e) => console.error('[sent thread] could not file a queued email', (e as Error).message));
    await query(`update email_queue set resolved_at = now(), resolution = 'FILED', resolved_matter_id = $3 where tenant_id = $1 and graph_message_id = $2 and resolved_at is null`, [user.tenantId, row.graph_message_id, matterId]).catch(() => {});
    filed += 1;
  }
  return { linked: true, filed };
}
