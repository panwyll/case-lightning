import { NextRequest, after } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { query, queryOne } from '@/lib/server/db';
import { assertMatterAccess } from '@/lib/server/guard';
import { describeFiling, fileEmailAttachments, fileEmailBodyAsDocument, indexEmailBodyToMatter } from '@/lib/server/files';
import { recordContactsFromMessage } from '@/lib/server/contacts';
import { ensureMasterCategory, addMessageCategories, getMessage } from '@/lib/server/graph';
import { matterColor } from '@/lib/server/colors';
import { writeAudit } from '@/lib/server/audit';
import { emitMatterEvent } from '@/lib/server/events';
import { ok, fail } from '@/lib/server/http';
import { resolveConversation } from '@/lib/server/mail/queue';
import { resolveMailbox, grantCaseIfAssistant } from '@/lib/server/access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: Promise<{ matterId: string }> }) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const { matterId } = z.object({ matterId: z.string().uuid() }).parse(await params);
    const body = z
      .object({
        graphThreadId: z.string(),
        graphConversationId: z.string().optional(),
        messageId: z.string().optional(),
        subject: z.string().optional(),
        participants: z.array(z.string()).default([]),
        category: z.string().default('Matter Linked'),
        /** Filing from a colleague's mailbox you have been granted. */
        mailboxUserId: z.string().uuid().nullish(),
      })
      .parse(await req.json());

    // An assistant may file to a case they cannot yet see; filing is what grants it.
    await grantCaseIfAssistant(user, matterId);
    await assertMatterAccess(user, matterId);
    const owner = await resolveMailbox(user, body.mailboxUserId);

    // Tag with the matter's own name (ref) so the email is visibly filed to the
    // matter in Outlook — same label/colour the auto-triage path uses. Falls back
    // to the caller-supplied category only if the ref is somehow missing.
    const matterRow = await queryOne<{ matter_ref: string | null }>(
      `select matter_ref from matter where id = $1 and tenant_id = $2`,
      [matterId, user.tenantId]
    );
    const label = matterRow?.matter_ref ?? body.category;

    // The matcher keys LINKED_THREAD on the message's Graph (REST) conversationId.
    // The client may send an Office/EWS conversationId that never equals it, so the
    // link would never fire. Resolve the canonical value from the message itself.
    let conversationId = body.graphConversationId ?? body.graphThreadId;
    let msg: Record<string, unknown> | null = null;
    if (body.messageId) {
      try {
        msg = await getMessage(owner.userId, body.messageId);
        if (msg && typeof msg.conversationId === 'string') conversationId = msg.conversationId;
      } catch {
        /* fall back to the client-supplied id */
      }
    }

    await query(
      `insert into email_thread (tenant_id, matter_id, graph_thread_id, graph_conversation_id, subject, participants, outlook_category)
       values ($1,$2,$3,$4,$5,$6::jsonb,$7)
       on conflict (tenant_id, graph_thread_id)
       do update set matter_id = excluded.matter_id,
                     graph_conversation_id = excluded.graph_conversation_id,
                     subject = excluded.subject,
                     participants = excluded.participants,
                     outlook_category = excluded.outlook_category`,
      [
        user.tenantId,
        matterId,
        body.graphThreadId,
        conversationId,
        body.subject ?? null,
        JSON.stringify(body.participants),
        label,
      ]
    );

    // The thread is on a case: its rows leave the filing queue.
    await resolveConversation(user.tenantId, conversationId, 'FILED', matterId).catch(() => {});

    // Stamp the matter-name category onto the actual Outlook message (best-effort).
    if (body.messageId) {
      await ensureMasterCategory(owner.userId, label, matterColor(label)).catch(() => {});
      await addMessageCategories(owner.userId, body.messageId, [label]).catch(() => {});
    }

    // Linking the email to a matter saves its attachments to the matter folder
    // (best-effort; no-ops when there are none). The email itself stays in the
    // inbox in-tray until the user actually actions it.
    await writeAudit({
      tenantId: user.tenantId,
      matterId,
      actorUserId: user.userId,
      actionType: 'THREAD_LINKED',
      actionStatus: 'SUCCESS',
      payload: { graphThreadId: body.graphThreadId },
    });

    // The link is done; the reading happens after the response so the pane is not held up.
    // Every step reports what it did, or why it could not, on the case's log: a silent
    // failure here looks to the person like the link did nothing.
    const messageId = body.messageId;
    const subject = body.subject;
    if (messageId) {
      after(async () => {
        let attachments: { saved: number; files: Array<{ name: string; outcome: string; as: string | null; reason: string | null }> } = { saved: 0, files: [] };
        let email: { outcome: string; as: string | null; reason: string | null; proposals?: number } | null = null;
        const problems: string[] = [];
        attachments = await fileEmailAttachments(owner, matterId, messageId, subject).catch((e) => {
          console.error('[link-thread] attachments failed', (e as Error).message);
          problems.push(`attachments could not be filed: ${(e as Error).message}`);
          return { saved: 0, files: [] };
        });
        if (msg) {
          // The people on the email become contacts (without a role until someone sets it); its words join the case's knowledge;
          // and the email itself is read like a filed document — a reply to enquiries in the body is a reply.
          await recordContactsFromMessage(user, matterId, msg).catch((e) => problems.push(`contacts not recorded: ${(e as Error).message}`));
          await indexEmailBodyToMatter(owner, matterId, msg).catch((e) => problems.push(`email not indexed: ${(e as Error).message}`));
          email = await fileEmailBodyAsDocument(owner, matterId, msg, attachments.files).catch((e) => {
            console.error('[link-thread] email body read failed', (e as Error).message);
            problems.push(`the email could not be read: ${(e as Error).message}`);
            return null;
          });
        } else {
          problems.push('the email could not be fetched from the mailbox, so nothing was read');
        }
        if (msg && (msg as { hasAttachments?: boolean }).hasAttachments && !attachments.files.length && !problems.length) problems.push('The email says it has attachments, but none could be listed from the mailbox');
        const said = describeFiling(email, attachments.files, problems);
        await emitMatterEvent({
          tenantId: user.tenantId,
          matterId,
          eventType: 'EMAIL_FILED',
          title: `Email filed: ${subject?.trim() || '(no subject)'}`,
          details: said.join('\n'),
        }).catch((e) => console.error('[link-thread] could not log the filing', (e as Error).message));
      });
    }

    return ok({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
