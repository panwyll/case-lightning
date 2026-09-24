import { query } from '../db';
import { listInboxMessages } from '../graph';

/**
 * What is in the inbox and not on a case: threads already filed to a matter are gone,
 * threads a person set aside are gone. Deterministic — no model call — so a count or a
 * page of it costs nothing but the mailbox read.
 */
export async function unfiledInbox(user: { userId: string; tenantId: string }, opts: { top?: number; nextLink?: string | null; search?: string | null } = {}) {
  const { messages, nextLink } = await listInboxMessages(user.userId, { top: opts.top ?? 25, nextLink: opts.nextLink ?? null, search: opts.search ?? null });
  const conversationIds = Array.from(new Set(messages.map((m: { conversationId?: string }) => m.conversationId).filter(Boolean))) as string[];
  const [filed, dismissed] = conversationIds.length
    ? await Promise.all([
        query<{ graph_conversation_id: string; matter_id: string; matter_ref: string }>(
          `select t.graph_conversation_id, t.matter_id, m.matter_ref
             from email_thread t join matter m on m.id = t.matter_id
            where t.tenant_id = $1 and t.graph_conversation_id = any($2::text[])`,
          [user.tenantId, conversationIds]
        ).catch(() => []),
        query<{ graph_conversation_id: string }>(`select graph_conversation_id from email_not_filed where tenant_id = $1 and graph_conversation_id = any($2::text[])`, [user.tenantId, conversationIds]).catch(() => []),
      ])
    : [[], []];
  const filedBy = new Map(filed.map((f) => [f.graph_conversation_id, f]));
  const setAside = new Set(dismissed.map((d) => d.graph_conversation_id));
  const unfiled = (messages as Array<Record<string, any>>).filter((m) => {
    const id = m.conversationId as string | undefined;
    return !id || (!filedBy.has(id) && !setAside.has(id));
  });
  return { unfiled, nextLink, filedBy, setAside };
}
