import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertEntitled } from '@/lib/server/plan';
import { queryOne } from '@/lib/server/db';
import { listThreadMessages, createReplyDraft } from '@/lib/server/graph';
import { draftReply, actingForPhrase } from '@/lib/server/ai';
import { threadToText } from '@/lib/server/text';
import { writeAudit } from '@/lib/server/audit';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * One click on a worklist chase → the chaser email is drafted straight into the
 * user's Outlook Drafts. The whole point of the worklist is that the next action
 * is the EMAIL, not list admin — so the primary button does the email.
 * Draft-only, as ever: nothing sends itself.
 */
export async function POST(req: NextRequest) {
  try {
    assertFeature('auth');
    assertFeature('graph');
    assertFeature('ai');
    const user = await requireUser();
    await assertEntitled(user.tenantId);
    const { threadId } = z.object({ threadId: z.string().uuid() }).parse(await req.json());

    const thread = await queryOne<{ id: string; matter_id: string; graph_conversation_id: string | null; chase_awaiting_since: string | null }>(
      `select id, matter_id, graph_conversation_id, chase_awaiting_since
         from email_thread where id = $1 and tenant_id = $2`,
      [threadId, user.tenantId]
    );
    if (!thread?.graph_conversation_id) return fail(new Error('Thread not found (or no conversation id).'));

    const msgs = await listThreadMessages(user.userId, thread.graph_conversation_id);
    const last = msgs[msgs.length - 1];
    if (!last?.id) return fail(new Error('No messages found in your mailbox for this thread.'));

    const [summary, matter, template] = await Promise.all([
      queryOne<{ facts: Record<string, unknown> }>(`select facts from matter_summary where matter_id = $1 and tenant_id = $2`, [thread.matter_id, user.tenantId]),
      queryOne<{ track: string | null }>(`select track from matter where id = $1 and tenant_id = $2`, [thread.matter_id, user.tenantId]).catch(() => null),
      queryOne<any>(`select * from template where tenant_id = $1 and style_tag = 'CHASING' and is_active = true order by updated_at desc limit 1`, [user.tenantId]),
    ]);

    const waitingDays = thread.chase_awaiting_since
      ? Math.max(1, Math.round((Date.now() - new Date(thread.chase_awaiting_since).getTime()) / 86_400_000))
      : null;

    const draft = await draftReply({
      userId: user.userId,
      tenantId: user.tenantId,
      matterId: thread.matter_id,
      tone: 'CHASING',
      actingFor: actingForPhrase(matter?.track ?? undefined),
      threadText: threadToText(msgs),
      matterFacts: summary?.facts ?? {},
      retrievedContext: '',
      templateText: template?.body_template ?? template?.bodyTemplate ?? '',
      guidance: `Write a short, courteous chase-up: we sent the last message${waitingDays ? ` ${waitingDays} days ago` : ''} and have had no reply. Ask for an update and, if natural, a date. Do not invent new facts.`,
      attachmentSummary: '',
    });

    const created = await createReplyDraft(user.userId, last.id, draft.bodyHtml);

    await writeAudit({
      tenantId: user.tenantId,
      matterId: thread.matter_id,
      actorUserId: user.userId,
      actionType: 'DRAFT_GENERATED',
      actionStatus: 'SUCCESS',
      payload: { source: 'WORKLIST_CHASER', threadId },
    });

    return ok({ webLink: created.webLink, subject: created.subject });
  } catch (error) {
    return fail(error);
  }
}
