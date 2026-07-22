import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireRole } from '@/lib/server/session';
import { query, queryOne } from '@/lib/server/db';
import { indexAutomation } from '@/lib/server/automations';
import { isPremiumTenant } from '@/lib/server/plan';
import { writeAudit } from '@/lib/server/audit';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

const Step = z.object({
  type: z.enum([
    'CREATE_MATTER', 'GENERATE_DOCS', 'CREATE_TASK', 'DRAFT_REPLY',
    'ARCHIVE_MATTER', 'DELEGATE', 'NOTIFY', 'TAG', 'APPEND_TRACKER', 'ASSIGN',
  ]),
  config: z.record(z.any()).default({}),
});

function hasSendingStep(steps: z.infer<typeof Step>[]): boolean {
  return steps.some((s) => s.type === 'DRAFT_REPLY' && s.config?.send === true);
}

export async function PATCH(req: NextRequest, { params }: Ctx) {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    const { id } = z.object({ id: z.string().uuid() }).parse(await params);
    const b = z
      .object({
        name: z.string().min(1).optional(),
        description: z.string().nullable().optional(),
        enabled: z.boolean().optional(),
        trigger: z.enum(['MANUAL', 'AUTO']).optional(),
        steps: z.array(Step).optional(),
        intents: z.array(z.string()).optional(),
        minConfidence: z.number().min(0).max(1).optional(),
        requireNoAttention: z.boolean().optional(),
        senderDomains: z.array(z.string()).optional(),
        matchStages: z.array(z.string()).optional(),
        riskAccepted: z.boolean().optional(),
        riskAcknowledgement: z.string().optional(),
      })
      .parse(await req.json());

    const existing = await queryOne<{ trigger: string; steps: any; name: string; description: string | null }>(
      `select trigger, steps, name, description from automation where id = $1 and tenant_id = $2`,
      [id, user.tenantId]
    );
    if (!existing) return fail(new Error('Automation not found'));

    const effTrigger = b.trigger ?? existing.trigger;
    const effSteps = b.steps ?? (Array.isArray(existing.steps) ? existing.steps : []);
    const sends = effTrigger === 'AUTO' && hasSendingStep(effSteps);

    if (b.enabled === true && effTrigger === 'AUTO' && !(await isPremiumTenant(user.tenantId))) {
      return fail(new Error('Premium automations require the Pro or Firm plan.'));
    }
    if (sends && b.enabled === true && (!b.riskAccepted || !b.riskAcknowledgement)) {
      return fail(new Error('Enabling an automation that auto-sends requires re-accepting responsibility (riskAccepted + riskAcknowledgement).'));
    }

    const row = await queryOne<{ name: string; description: string | null; trigger: string }>(
      `update automation set
         name                 = coalesce($1, name),
         description          = case when $2 then $3 else description end,
         enabled              = coalesce($4, enabled),
         trigger              = coalesce($5, trigger),
         steps                = coalesce($6::jsonb, steps),
         intents              = coalesce($7, intents),
         min_confidence       = coalesce($8, min_confidence),
         require_no_attention = coalesce($9, require_no_attention),
         sender_domains       = coalesce($10, sender_domains),
         match_stages         = coalesce($11, match_stages),
         risk_accepted        = case when $12 then coalesce($13, risk_accepted) else risk_accepted end,
         risk_acknowledgement = case when $12 and $13 = true then $14 else risk_acknowledgement end,
         risk_accepted_by     = case when $12 and $13 = true then $15 else risk_accepted_by end,
         risk_accepted_at     = case when $12 and $13 = true then now() else risk_accepted_at end,
         updated_at = now()
       where id = $16 and tenant_id = $17
       returning name, description, trigger`,
      [
        b.name ?? null,
        b.description !== undefined,
        b.description ?? null,
        b.enabled ?? null,
        b.trigger ?? null,
        b.steps ? JSON.stringify(b.steps) : null,
        b.intents ?? null,
        b.minConfidence ?? null,
        b.requireNoAttention ?? null,
        b.senderDomains ?? null,
        b.matchStages ?? null,
        sends, // only touch risk fields when the effective automation actually sends
        b.riskAccepted ?? null,
        b.riskAcknowledgement ?? null,
        user.userId,
        id,
        user.tenantId,
      ]
    );

    if (row && row.trigger === 'MANUAL') await indexAutomation(user.tenantId, id, row.name, row.description);

    await writeAudit({
      tenantId: user.tenantId,
      actorUserId: user.userId,
      actionType: 'AUTO_RULE_UPDATED',
      actionStatus: 'SUCCESS',
      payload: { automationId: id, enabled: b.enabled, trigger: effTrigger },
    });

    return ok({ updated: true });
  } catch (error) {
    return fail(error);
  }
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    const { id } = z.object({ id: z.string().uuid() }).parse(await params);
    await query(`delete from automation where id = $1 and tenant_id = $2`, [id, user.tenantId]);
    await writeAudit({
      tenantId: user.tenantId,
      actorUserId: user.userId,
      actionType: 'AUTO_RULE_DELETED',
      actionStatus: 'SUCCESS',
      payload: { automationId: id },
    });
    return ok({ deleted: true });
  } catch (error) {
    return fail(error);
  }
}
