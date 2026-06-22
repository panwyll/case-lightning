import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { queryOne } from '@/lib/server/db';
import { assertMatterAccess, externalDomainsAllowed } from '@/lib/server/guard';
import { getMessage, createReplyDraft } from '@/lib/server/graph';
import { writeAudit } from '@/lib/server/audit';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Creates a DRAFT reply in Outlook only. There is deliberately no send endpoint.
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
        subject: z.string().optional(),
        bodyHtml: z.string().min(1),
      })
      .parse(await req.json());

    // A matter is optional. With one we gate access and tag the subject with its
    // case-ref token; the recipient-domain policy check below always applies.
    if (body.matterId) await assertMatterAccess(user, body.matterId);
    const policy = await queryOne<{ allowed_external_domains: string[] }>(
      `select allowed_external_domains from policy_config where tenant_id = $1`,
      [user.tenantId]
    );
    // Append the matter's case-ref token to the subject so future replies in this
    // thread self-identify their matter — the strongest, GDPR-clean match signal.
    const matterRow = body.matterId
      ? await queryOne<{ case_ref_token: string | null }>(
          `select case_ref_token from matter where id = $1 and tenant_id = $2`,
          [body.matterId, user.tenantId]
        )
      : null;
    const token = matterRow?.case_ref_token ?? undefined;
    const message = await getMessage(user.userId, body.messageId);
    const recipients = [
      ...(message.toRecipients ?? []).map((r: any) => r.emailAddress?.address),
      ...(message.ccRecipients ?? []).map((r: any) => r.emailAddress?.address),
    ].filter(Boolean) as string[];

    if (!externalDomainsAllowed(recipients, policy?.allowed_external_domains ?? [])) {
      await writeAudit({
        tenantId: user.tenantId,
        matterId: body.matterId ?? null,
        actorUserId: user.userId,
        actionType: 'OUTLOOK_DRAFT_CREATED',
        actionStatus: 'BLOCKED',
        payload: { reason: 'recipient_domain_not_allowed' },
      });
      return fail(new Error('One or more recipient domains are not allowed by policy'));
    }

    const draft = await createReplyDraft(user.userId, body.messageId, body.bodyHtml, { appendToken: token });

    await writeAudit({
      tenantId: user.tenantId,
      matterId: body.matterId ?? null,
      actorUserId: user.userId,
      actionType: 'OUTLOOK_DRAFT_CREATED',
      actionStatus: 'SUCCESS',
      payload: { draftId: draft.id, graphThreadId },
    });

    return ok({ draftId: draft.id, webLink: draft.webLink, subject: draft.subject, bodyHtml: body.bodyHtml });
  } catch (error) {
    return fail(error);
  }
}
