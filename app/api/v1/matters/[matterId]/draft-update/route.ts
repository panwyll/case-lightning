import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { queryOne } from '@/lib/server/db';
import { assertMatterAccess } from '@/lib/server/guard';
import { listThreadMessages, createDraftMessage } from '@/lib/server/graph';
import { draftUpdate, retrieveMatterContext } from '@/lib/server/ai';
import { reviewAttachmentsContext } from '@/lib/server/files';
import { threadToText } from '@/lib/server/text';
import { writeAudit } from '@/lib/server/audit';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ matterId: string }> };

const ROLE_LABEL: Record<string, string> = {
  CLIENT: 'the client',
  OTHER_SIDE: "the other side's solicitor",
  AGENT: 'the estate agent',
  LENDER: 'the lender',
  OUR_FIRM: 'our firm',
  OTHER: 'a contact',
  UNKNOWN: 'a contact',
};

// Draft a fresh outbound UPDATE to a specific party on the matter (e.g. tell the
// client the searches are back) and create it as an Outlook draft addressed to
// them — never sent. Reuses the matter facts / RAG context / attachment review
// that drive the reply draft, so the update is grounded in the same picture.
export async function POST(req: NextRequest, { params }: Ctx) {
  try {
    assertFeature('auth');
    assertFeature('graph');
    assertFeature('ai');
    const user = await requireUser();
    const { matterId } = z.object({ matterId: z.string().uuid() }).parse(await params);
    const body = z
      .object({
        toEmail: z.string().email(),
        toName: z.string().optional(),
        role: z.string().optional(),
        messageId: z.string().optional(),
        conversationId: z.string().optional(),
      })
      .parse(await req.json());
    await assertMatterAccess(user, matterId);

    const threadText = body.conversationId
      ? threadToText(await listThreadMessages(user.userId, body.conversationId))
      : '';

    const matterSummary = await queryOne<{ facts: Record<string, unknown> }>(
      `select facts from matter_summary where matter_id = $1 and tenant_id = $2`,
      [matterId, user.tenantId]
    );
    const policy = await queryOne<{ default_disclaimer: string }>(
      `select default_disclaimer from policy_config where tenant_id = $1`,
      [user.tenantId]
    );

    const retrieved = await retrieveMatterContext({
      tenantId: user.tenantId,
      matterId,
      queryText: `Update for ${ROLE_LABEL[body.role ?? 'UNKNOWN'] ?? 'a contact'} on this matter`,
      includePlaybook: true,
      limit: 10,
    });
    let retrievedContext = retrieved.map((r) => `${r.source_kind}: ${r.chunk_text}`).join('\n---\n');
    if (body.messageId) {
      const attach = await reviewAttachmentsContext(user, matterId, body.messageId).catch(() => '');
      if (attach) retrievedContext = retrievedContext ? `${retrievedContext}\n---\n${attach}` : attach;
    }

    const draft = await draftUpdate({
      userId: user.userId,
      tenantId: user.tenantId,
      matterId,
      recipientName: body.toName || body.toEmail,
      recipientRole: ROLE_LABEL[body.role ?? 'UNKNOWN'] ?? 'a contact',
      threadText,
      matterFacts: matterSummary?.facts ?? {},
      retrievedContext,
      templateText: policy?.default_disclaimer ?? '',
    });

    const created = await createDraftMessage(user.userId, draft.subject, draft.bodyHtml, [body.toEmail]);

    await writeAudit({
      tenantId: user.tenantId,
      matterId,
      actorUserId: user.userId,
      actionType: 'DRAFT_GENERATED',
      actionStatus: 'SUCCESS',
      payload: { kind: 'UPDATE', toEmail: body.toEmail, role: body.role ?? null },
    });

    return ok({ draftId: created?.id ?? null, subject: draft.subject });
  } catch (error) {
    return fail(error);
  }
}
