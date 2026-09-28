import { NextRequest, after } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { query } from '@/lib/server/db';
import { ok, fail } from '@/lib/server/http';
import { writeAudit } from '@/lib/server/audit';
import { resolveConversation, reopenConversation } from '@/lib/server/mail/queue';
import { resolveMailbox } from '@/lib/server/access';
import { archiveHandled, unarchiveHandled } from '@/lib/server/mail/archive';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({ conversationId: z.string().min(1).max(500), subject: z.string().max(500).nullish(), reason: z.string().max(500).nullish(), mailboxUserId: z.string().uuid().nullish() });

/**
 * "This is not case email." Sets the thread aside so the filing queue stops offering it, and
 * (the firm's switch, on by default) archives it in the mailbox so the Outlook inbox matches
 * the Email tab. Nothing is deleted; undoing puts it back in the queue and the inbox.
 */
export async function POST(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const input = schema.parse(await req.json());
    const owner = await resolveMailbox(user, input.mailboxUserId); // 403 unless it is yours or granted
    await query(
      `insert into email_not_filed (tenant_id, graph_conversation_id, subject, dismissed_by, reason)
       values ($1,$2,$3,$4,$5) on conflict (tenant_id, graph_conversation_id) do nothing`,
      [user.tenantId, input.conversationId, input.subject ?? null, user.userId, input.reason ?? null]
    );
    await resolveConversation(user.tenantId, input.conversationId, 'SET_ASIDE').catch(() => {});
    await writeAudit({ tenantId: user.tenantId, actorUserId: user.userId, actionType: 'EMAIL_SET_ASIDE', actionStatus: 'SUCCESS', payload: { conversationId: input.conversationId } }).catch(() => {});
    after(() => archiveHandled(user.tenantId, owner.userId, input.conversationId).then(() => {}));
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
    const owner = await resolveMailbox(user, req.nextUrl.searchParams.get('mailboxUserId')).catch(() => ({ userId: user.userId }));
    after(() => unarchiveHandled(user.tenantId, owner.userId, conversationId).then(() => {}));
    return ok({ restored: true });
  } catch (error) {
    return fail(error);
  }
}
