import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireRole } from '@/lib/server/session';
import { query, queryOne } from '@/lib/server/db';
import { isPremiumTenant } from '@/lib/server/plan';
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
        name: z.string().min(1).optional(),
        enabled: z.boolean().optional(),
        intents: z.array(z.string()).optional(),
        minConfidence: z.number().min(0).max(1).optional(),
        requireNoAttention: z.boolean().optional(),
        senderDomains: z.array(z.string()).optional(),
        doCategorize: z.boolean().optional(),
        categoryLabel: z.string().nullable().optional(),
        doAssign: z.boolean().optional(),
        assignTo: z.string().uuid().nullable().optional(),
        doAppendTracker: z.boolean().optional(),
        replyMode: z.enum(['NONE', 'DRAFT', 'SEND']).optional(),
        replyTemplateId: z.string().uuid().nullable().optional(),
        riskAccepted: z.boolean().optional(),
        riskAcknowledgement: z.string().optional(),
      })
      .parse(await req.json());

    const existing = await queryOne<{ reply_mode: string }>(
      `select reply_mode from auto_rule where id = $1 and tenant_id = $2`,
      [ruleId, user.tenantId]
    );
    if (!existing) return fail(new Error('Rule not found'));

    if (b.enabled === true && !(await isPremiumTenant(user.tenantId))) {
      return fail(new Error('Premium auto-rules require the Pro or Firm plan.'));
    }

    const effectiveMode = b.replyMode ?? existing.reply_mode;
    // Re-enabling (or keeping enabled) a SEND rule requires fresh risk acceptance.
    if (effectiveMode === 'SEND' && b.enabled === true && (!b.riskAccepted || !b.riskAcknowledgement)) {
      return fail(
        new Error('Enabling an auto-SEND rule requires re-accepting responsibility (riskAccepted + riskAcknowledgement).')
      );
    }

    // The three nullable FK/label fields must be distinguishable between "not sent" (keep)
    // and "explicitly cleared" (null), so each carries a `provided` flag.
    const row = await queryOne<any>(
      `update auto_rule set
         name                 = coalesce($1, name),
         enabled              = coalesce($2, enabled),
         intents              = coalesce($3, intents),
         min_confidence       = coalesce($4, min_confidence),
         require_no_attention = coalesce($5, require_no_attention),
         sender_domains       = coalesce($6, sender_domains),
         do_categorize        = coalesce($7, do_categorize),
         category_label       = case when $8 then $9 else category_label end,
         do_assign            = coalesce($10, do_assign),
         assign_to            = case when $11 then $12::uuid else assign_to end,
         do_append_tracker    = coalesce($13, do_append_tracker),
         reply_mode           = coalesce($14, reply_mode),
         reply_template_id    = case when $15 then $16::uuid else reply_template_id end,
         risk_accepted        = case when $17 = 'SEND' then coalesce($18, risk_accepted) else risk_accepted end,
         risk_acknowledgement = case when $17 = 'SEND' and $18 = true then $19 else risk_acknowledgement end,
         risk_accepted_by     = case when $17 = 'SEND' and $18 = true then $20 else risk_accepted_by end,
         risk_accepted_at     = case when $17 = 'SEND' and $18 = true then now() else risk_accepted_at end,
         updated_at = now()
       where id = $21 and tenant_id = $22 returning *`,
      [
        b.name ?? null,
        b.enabled ?? null,
        b.intents ?? null,
        b.minConfidence ?? null,
        b.requireNoAttention ?? null,
        b.senderDomains ?? null,
        b.doCategorize ?? null,
        b.categoryLabel !== undefined,
        b.categoryLabel ?? null,
        b.doAssign ?? null,
        b.assignTo !== undefined,
        b.assignTo ?? null,
        b.doAppendTracker ?? null,
        b.replyMode ?? null,
        b.replyTemplateId !== undefined,
        b.replyTemplateId ?? null,
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

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ ruleId: string }> }) {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    const { ruleId } = z.object({ ruleId: z.string().uuid() }).parse(await params);
    await query(`delete from auto_rule where id = $1 and tenant_id = $2`, [ruleId, user.tenantId]);
    await writeAudit({
      tenantId: user.tenantId,
      actorUserId: user.userId,
      actionType: 'AUTO_RULE_DELETED',
      actionStatus: 'SUCCESS',
      payload: { ruleId },
    });
    return ok({ deleted: true });
  } catch (error) {
    return fail(error);
  }
}
