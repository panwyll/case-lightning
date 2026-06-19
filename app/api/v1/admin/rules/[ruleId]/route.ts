import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireRole } from '@/lib/server/session';
import { queryOne } from '@/lib/server/db';
import { writeAudit } from '@/lib/server/audit';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ ruleId: string }> }) {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    const { ruleId } = z.object({ ruleId: z.string().uuid() }).parse(await params);
    const b = z
      .object({
        enabled: z.boolean().optional(),
        minConfidence: z.number().min(0).max(1).optional(),
        intents: z.array(z.string()).optional(),
        senderDomains: z.array(z.string()).optional(),
        replyMode: z.enum(['NONE', 'DRAFT', 'SEND']).optional(),
        riskAccepted: z.boolean().optional(),
        riskAcknowledgement: z.string().optional(),
      })
      .parse(await req.json());

    const existing = await queryOne<{ reply_mode: string }>(
      `select reply_mode from auto_rule where id = $1 and tenant_id = $2`,
      [ruleId, user.tenantId]
    );
    if (!existing) return fail(new Error('Rule not found'));

    const effectiveMode = b.replyMode ?? existing.reply_mode;
    // Re-enabling (or keeping enabled) a SEND rule requires fresh risk acceptance.
    if (effectiveMode === 'SEND' && b.enabled === true && (!b.riskAccepted || !b.riskAcknowledgement)) {
      return fail(
        new Error('Enabling an auto-SEND rule requires re-accepting responsibility (riskAccepted + riskAcknowledgement).')
      );
    }

    const row = await queryOne<any>(
      `update auto_rule set
         enabled = coalesce($1, enabled),
         min_confidence = coalesce($2, min_confidence),
         intents = coalesce($3, intents),
         sender_domains = coalesce($4, sender_domains),
         reply_mode = coalesce($5, reply_mode),
         risk_accepted = case when $6 = 'SEND' then coalesce($7, risk_accepted) else risk_accepted end,
         risk_acknowledgement = case when $6 = 'SEND' and $7 = true then $8 else risk_acknowledgement end,
         risk_accepted_by = case when $6 = 'SEND' and $7 = true then $9 else risk_accepted_by end,
         risk_accepted_at = case when $6 = 'SEND' and $7 = true then now() else risk_accepted_at end,
         updated_at = now()
       where id = $10 and tenant_id = $11 returning *`,
      [
        b.enabled ?? null,
        b.minConfidence ?? null,
        b.intents ?? null,
        b.senderDomains ?? null,
        b.replyMode ?? null,
        effectiveMode,
        b.riskAccepted ?? null,
        b.riskAcknowledgement ?? null,
        user.userId,
        ruleId,
        user.tenantId,
      ]
    );

    await writeAudit({
      tenantId: user.tenantId,
      actorUserId: user.userId,
      actionType: 'AUTO_RULE_UPDATED',
      actionStatus: 'SUCCESS',
      payload: { ruleId, enabled: b.enabled, replyMode: effectiveMode, riskAccepted: b.riskAccepted },
    });

    return ok({ rule: row });
  } catch (error) {
    return fail(error);
  }
}
