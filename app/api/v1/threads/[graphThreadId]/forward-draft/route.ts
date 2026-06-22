import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { queryOne } from '@/lib/server/db';
import { assertMatterAccess } from '@/lib/server/guard';
import { createForwardDraft } from '@/lib/server/graph';
import { writeAudit } from '@/lib/server/audit';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Creates a DRAFT forward of the open email to a colleague, with the delegator's
// instructions as the lead comment. Draft-only — never sent. Backs the Delegate
// move (alongside the tracker assignment, which the tasks endpoint handles).
export async function POST(req: NextRequest, { params }: { params: Promise<{ graphThreadId: string }> }) {
  try {
    assertFeature('auth');
    assertFeature('graph');
    const user = await requireUser();
    const { graphThreadId } = await params;
    const body = z
      .object({
        matterId: z.string().uuid().optional(),
        messageId: z.string(),
        toEmail: z.string().email(),
        instructions: z.string().optional(),
      })
      .parse(await req.json());

    if (body.matterId) await assertMatterAccess(user, body.matterId);

    const matterRow = body.matterId
      ? await queryOne<{ matter_ref: string }>(`select matter_ref from matter where id = $1 and tenant_id = $2`, [
          body.matterId,
          user.tenantId,
        ])
      : null;

    const lead = body.instructions?.trim();
    const ctx = matterRow ? ` (matter ${matterRow.matter_ref})` : '';
    const comment = lead
      ? `${lead}${ctx ? `\n\n${ctx.trim()}` : ''}`
      : `Please handle the forwarded email${ctx}.`;

    const draft = await createForwardDraft(user.userId, body.messageId, body.toEmail, comment);

    await writeAudit({
      tenantId: user.tenantId,
      matterId: body.matterId ?? null,
      actorUserId: user.userId,
      actionType: 'OUTLOOK_DRAFT_CREATED',
      actionStatus: 'SUCCESS',
      payload: { kind: 'FORWARD', draftId: draft.id, graphThreadId, toEmail: body.toEmail },
    });

    return ok({ draftId: draft.id, webLink: draft.webLink, subject: draft.subject, instructions: comment });
  } catch (error) {
    return fail(error);
  }
}
