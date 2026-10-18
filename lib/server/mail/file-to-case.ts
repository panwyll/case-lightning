/**
 * File an email from someone's mailbox to a case, as filing it on the Email tab does: the conversation is linked to the
 * case (so its replies follow), it leaves the filing queue, and it is read (attachments, the email itself). Used where a
 * person has already chosen the case somewhere else (an email filed in InTouch).
 */
import { query } from '../db';
import { getMessage } from '../graph';
import type { SessionUser } from '../types';
import { resolveConversation } from './queue';
import { autoFileToCase } from './auto-file';

export async function fileMailboxEmailToCase(owner: SessionUser, matterId: string, messageId: string, fallbackConversationId: string | null = null): Promise<void> {
  const message = await getMessage(owner.userId, messageId);
  const conversationId: string = message?.conversationId ?? fallbackConversationId ?? messageId;
  const ref = (await query<{ matter_ref: string }>(`select matter_ref from matter where id = $1 and tenant_id = $2`, [matterId, owner.tenantId]))[0]?.matter_ref ?? null;
  await query(
    `insert into email_thread (tenant_id, matter_id, graph_thread_id, graph_conversation_id, subject, participants, outlook_category)
     values ($1,$2,$3,$3,$4,'[]'::jsonb,$5) on conflict (tenant_id, graph_thread_id) do update set matter_id = excluded.matter_id`,
    [owner.tenantId, matterId, conversationId, message?.subject ?? null, ref]
  );
  await resolveConversation(owner.tenantId, conversationId, 'FILED', matterId).catch(() => {});
  await autoFileToCase(owner, message, matterId);
}
