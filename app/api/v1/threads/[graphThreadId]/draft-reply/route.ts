import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { query, queryOne } from '@/lib/server/db';
import { assertMatterAccess } from '@/lib/server/guard';
import { listThreadMessages } from '@/lib/server/graph';
import { draftReply, retrieveMatterContext } from '@/lib/server/ai';
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
        matterId: z.string().uuid(),
        messageId: z.string(),
        tone: z.enum(['NEUTRAL', 'FIRM', 'CHASING']).default('NEUTRAL'),
        templateId: z.string().uuid().optional(),
        conversationId: z.string().optional(),
      })
      .parse(await req.json());

    await assertMatterAccess(user, body.matterId);
    const conversationId = body.conversationId ?? graphThreadId;
    const threadText = threadToText(await listThreadMessages(user.userId, conversationId));

    const matterSummary = await queryOne<{ facts: Record<string, unknown> }>(
      `select facts from matter_summary where matter_id = $1 and tenant_id = $2`,
      [body.matterId, user.tenantId]
    );

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

    const retrieved = await retrieveMatterContext({
      tenantId: user.tenantId,
      matterId: body.matterId,
      queryText: `Draft reply for thread ${graphThreadId}`,
      includePlaybook: true,
      limit: 10,
    });
    const retrievedContext = retrieved.map((r) => `${r.source_kind}: ${r.chunk_text}`).join('\n---\n');
    const templateText = `${template ? `${template.subject_template ?? ''}\n${template.body_template}` : ''}\n${
      policy?.default_disclaimer ?? ''
    }`;

    const draft = await draftReply({
      userId: user.userId,
      tenantId: user.tenantId,
      matterId: body.matterId,
      tone: body.tone,
      threadText,
      matterFacts: matterSummary?.facts ?? {},
      retrievedContext,
      templateText,
    });

    const docs = await query<any>(
      `select id, file_name, web_url, storage_path, created_at from document
       where matter_id = $1 and tenant_id = $2 order by created_at desc limit 10`,
      [body.matterId, user.tenantId]
    );

    await writeAudit({
      tenantId: user.tenantId,
      matterId: body.matterId,
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
