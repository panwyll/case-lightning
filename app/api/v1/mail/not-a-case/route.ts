import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { query } from '@/lib/server/db';
import { ok, fail } from '@/lib/server/http';
import { writeAudit } from '@/lib/server/audit';
import { resolveConversation, reopenConversation } from '@/lib/server/mail/queue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({ conversationId: z.string().min(1).max(500), subject: z.string().max(500).nullish(), reason: z.string().max(500).nullish() });

/**
 * "This is not case email." Sets the thread aside so the filing queue stops offering it.
 *
 * Nothing is deleted, archived or moved: the email is the firm's, in the firm's mailbox,
 * and a filing tool has no business touching it. This only records that somebody looked.
 */
export async function POST(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const input = schema.parse(await req.json());
    await query(
      `insert into email_not_filed (tenant_id, graph_conversation_id, subject, dismissed_by, reason)
       values ($1,$2,$3,$4,$5) on conflict (tenant_id, graph_conversation_id) do nothing`,
      [user.tenantId, input.conversationId, input.subject ?? null, user.userId, input.reason ?? null]
    );
    await resolveConversation(user.tenantId, input.conversationId, 'SET_ASIDE').catch(() => {});
    await writeAudit({ tenantId: user.tenantId, actorUserId: user.userId, actionType: 'EMAIL_SET_ASIDE', actionStatus: 'SUCCESS', payload: { conversationId: input.conversationId } }).catch(() => {});
    return ok({ setAside: true });
  } catch (error) {
    return fail(error);
  }
}

/** Undo: put the thread back in the queue. */
export async function DELETE(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const conversationId = z.string().min(1).parse(req.nextUrl.searchParams.get('conversationId'));
    await query(`delete from email_not_filed where tenant_id = $1 and graph_conversation_id = $2`, [user.tenantId, conversationId]);
    await reopenConversation(user.tenantId, conversationId).catch(() => {});
    return ok({ restored: true });
  } catch (error) {
    return fail(error);
  }
}
