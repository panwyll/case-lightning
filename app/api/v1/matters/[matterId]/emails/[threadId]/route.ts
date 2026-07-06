import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { queryOne } from '@/lib/server/db';
import { assertMatterAccess } from '@/lib/server/guard';
import { listThreadMessages } from '@/lib/server/graph';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * A thread's messages, read live from Graph — nothing is copied into Postgres.
 * Bodies come back as plain text (Graph converts server-side), so no third-party
 * HTML is ever rendered in the web app.
 *
 * Mailbox reality: /me/messages only sees the caller's own mailbox. If the viewer
 * isn't on the thread (an ADMIN overseeing a colleague's matter), we retry with the
 * matter owner's token — matter correspondence is firm data, and this mirrors what
 * the admin could already read via the audit/summary surfaces. Non-admins only ever
 * read their own mailbox.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ matterId: string; threadId: string }> }) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const { matterId, threadId } = z
      .object({ matterId: z.string().uuid(), threadId: z.string().uuid() })
      .parse(await params);
    await assertMatterAccess(user, matterId);

    const thread = await queryOne<{ conversation_id: string | null }>(
      `select graph_conversation_id as conversation_id from email_thread
        where id = $1 and matter_id = $2 and tenant_id = $3`,
      [threadId, matterId, user.tenantId]
    );
    if (!thread) return fail(new Error('Thread not found'));
    if (!thread.conversation_id) return ok({ messages: [], reason: 'NO_CONVERSATION_ID' });

    let raw = await listThreadMessages(user.userId, thread.conversation_id, { textBodies: true }).catch(() => []);

    if (!raw.length && user.role === 'ADMIN') {
      const owner = await queryOne<{ assigned_to: string | null }>(
        `select assigned_to from matter where id = $1 and tenant_id = $2`,
        [matterId, user.tenantId]
      );
      if (owner?.assigned_to && owner.assigned_to !== user.userId) {
        raw = await listThreadMessages(owner.assigned_to, thread.conversation_id, { textBodies: true }).catch(() => []);
      }
    }

    const messages = raw.map((m: any) => ({
      id: m.id,
      from: m.from?.emailAddress?.name || m.from?.emailAddress?.address || 'Unknown',
      fromAddress: m.from?.emailAddress?.address ?? null,
      to: (m.toRecipients ?? []).map((r: any) => r.emailAddress?.name || r.emailAddress?.address).filter(Boolean),
      sentAt: m.receivedDateTime ?? m.sentDateTime ?? null,
      subject: m.subject ?? null,
      bodyText: String(m.body?.content ?? '').trim(),
      hasAttachments: Boolean(m.hasAttachments),
      webLink: m.webLink ?? null,
    }));
    return ok({ messages });
  } catch (error) {
    return fail(error);
  }
}
