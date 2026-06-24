import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { query, queryOne } from '@/lib/server/db';
import { assertMatterAccess } from '@/lib/server/guard';
import { listThreadMessages } from '@/lib/server/graph';
import { draftReply, retrieveMatterContext, actingForPhrase } from '@/lib/server/ai';
import { reviewAttachmentsContext, attachmentGroundTruth } from '@/lib/server/files';
import { threadToText } from '@/lib/server/text';
import { writeAudit } from '@/lib/server/audit';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: Promise<{ graphThreadId: string }> }) {
  try {
    assertFeature('auth');
    assertFeature('graph');
    assertFeature('ai');
    const user = await requireUser();
    const { graphThreadId } = await params;
    const body = z
      .object({
        matterId: z.string().uuid().optional(),
        messageId: z.string(),
        tone: z.enum(['NEUTRAL', 'FIRM', 'CHASING']).default('NEUTRAL'),
        templateId: z.string().uuid().optional(),
        conversationId: z.string().optional(),
        guidance: z.string().max(2000).optional(),
      })
      .parse(await req.json());

    // A matter is optional. Without one we still draft a reply from the thread +
    // firm template/disclaimer, but skip matter facts, RAG context and the
    // referenced-documents list (all matter-scoped).
    if (body.matterId) await assertMatterAccess(user, body.matterId);
    const conversationId = body.conversationId ?? graphThreadId;
    const threadText = threadToText(await listThreadMessages(user.userId, conversationId));

    const matterSummary = body.matterId
      ? await queryOne<{ facts: Record<string, unknown> }>(
          `select facts from matter_summary where matter_id = $1 and tenant_id = $2`,
          [body.matterId, user.tenantId]
        )
      : null;

    // Which side we act for, to steer the draft. Guarded for pre-migration-020 deploys.
    let actingFor: string | undefined;
    if (body.matterId) {
      try {
        const t = await queryOne<{ track: string }>(`select track from matter where id = $1 and tenant_id = $2`, [body.matterId, user.tenantId]);
        actingFor = actingForPhrase(t?.track);
      } catch {
        /* track column not migrated yet */
      }
    }

    const template = body.templateId
      ? await queryOne<any>(`select * from template where id = $1 and tenant_id = $2 and is_active = true`, [
          body.templateId,
          user.tenantId,
        ])
      : await queryOne<any>(
          `select * from template where tenant_id = $1 and style_tag = $2 and is_active = true order by updated_at desc limit 1`,
          [user.tenantId, body.tone]
        );

    const policy = await queryOne<{ default_disclaimer: string }>(
      `select default_disclaimer from policy_config where tenant_id = $1`,
      [user.tenantId]
    );

    const retrieved = body.matterId
      ? await retrieveMatterContext({
          tenantId: user.tenantId,
          matterId: body.matterId,
          queryText: `Draft reply for thread ${graphThreadId}`,
          includePlaybook: true,
          limit: 10,
        })
      : [];
    let retrievedContext = retrieved.map((r) => `${r.source_kind}: ${r.chunk_text}`).join('\n---\n');
    // Review any attachments on this email against the matter and fold the findings
    // into the draft (e.g. replying to a document sent for review).
    if (body.matterId) {
      const attach = await reviewAttachmentsContext(user, body.matterId, body.messageId).catch(() => '');
      if (attach) retrievedContext = retrievedContext ? `${retrievedContext}\n---\n${attach}` : attach;
    }
    const templateText = `${template ? `${template.subject_template ?? ''}\n${template.body_template}` : ''}\n${
      policy?.default_disclaimer ?? ''
    }`;

    // Ground truth on what's actually attached, so the drafter doesn't acknowledge
    // enclosures that aren't there.
    const attachmentSummary = await attachmentGroundTruth(user.userId, body.messageId).catch(() => '');

    const draft = await draftReply({
      userId: user.userId,
      tenantId: user.tenantId,
      matterId: body.matterId ?? null,
      tone: body.tone,
      actingFor,
      threadText,
      matterFacts: matterSummary?.facts ?? {},
      retrievedContext,
      templateText,
      guidance: body.guidance,
      attachmentSummary,
    });

    const docs = body.matterId
      ? await query<any>(
          `select id, file_name, web_url, storage_path, created_at from document
           where matter_id = $1 and tenant_id = $2 order by created_at desc limit 10`,
          [body.matterId, user.tenantId]
        )
      : [];

    await writeAudit({
      tenantId: user.tenantId,
      matterId: body.matterId ?? null,
      actorUserId: user.userId,
      actionType: 'DRAFT_GENERATED',
      actionStatus: 'SUCCESS',
      payload: { graphThreadId, tone: body.tone },
    });

    return ok({
      subject: draft.subject,
      bodyHtml: draft.bodyHtml,
      why: draft.why,
      referencedDocuments: docs,
      actions: draft.actions,
      messageId: body.messageId,
    });
  } catch (error) {
    return fail(error);
  }
}
