import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { query } from '@/lib/server/db';
import { assertMatterAccess } from '@/lib/server/guard';
import { saveEmailAttachmentsToMatter } from '@/lib/server/files';
import { writeAudit } from '@/lib/server/audit';
import { ok, fail } from '@/lib/server/http';

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
      })
      .parse(await req.json());

    await assertMatterAccess(user, matterId);

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
        body.graphConversationId ?? body.graphThreadId,
        body.subject ?? null,
        JSON.stringify(body.participants),
        body.category,
      ]
    );

    // Linking the email to a matter saves its attachments to the matter folder
    // (best-effort; no-ops when there are none). The email itself stays in the
    // inbox in-tray until the user actually actions it.
    if (body.messageId) {
      await saveEmailAttachmentsToMatter(user, matterId, body.messageId, body.subject).catch(() => {});
    }

    await writeAudit({
      tenantId: user.tenantId,
      matterId,
      actorUserId: user.userId,
      actionType: 'THREAD_LINKED',
      actionStatus: 'SUCCESS',
      payload: { graphThreadId: body.graphThreadId },
    });

    return ok({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
