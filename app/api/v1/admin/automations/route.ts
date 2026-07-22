import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireRole } from '@/lib/server/session';
import { queryOne } from '@/lib/server/db';
import { listAutomations, indexAutomation, ensureDefaultAutomations } from '@/lib/server/automations';
import { isPremiumTenant } from '@/lib/server/plan';
import { writeAudit } from '@/lib/server/audit';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Step = z.object({
  type: z.enum([
    'CREATE_MATTER', 'GENERATE_DOCS', 'CREATE_TASK', 'DRAFT_REPLY',
    'ARCHIVE_MATTER', 'DELEGATE', 'NOTIFY', 'TAG', 'APPEND_TRACKER', 'ASSIGN',
  ]),
  config: z.record(z.any()).default({}),
});

const automationSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  enabled: z.boolean().default(false),
  trigger: z.enum(['MANUAL', 'AUTO']).default('MANUAL'),
  steps: z.array(Step).default([]),
  // AUTO-only match conditions:
  intents: z.array(z.string()).default([]),
  minConfidence: z.number().min(0).max(1).default(0.9),
  requireNoAttention: z.boolean().default(true),
  senderDomains: z.array(z.string()).default([]),
  matchStages: z.array(z.string()).default([]),
  // Required to enable an AUTO automation whose steps send.
  riskAccepted: z.boolean().default(false),
  riskAcknowledgement: z.string().optional(),
});

/** Does this step list send an email without review (AUTO + a DRAFT_REPLY with send)? */
function hasSendingStep(steps: z.infer<typeof Step>[]): boolean {
  return steps.some((s) => s.type === 'DRAFT_REPLY' && s.config?.send === true);
}

export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    await ensureDefaultAutomations(user.tenantId, user.userId);
    return ok({ automations: await listAutomations(user.tenantId) });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    const b = automationSchema.parse(await req.json());

    if (b.enabled && b.trigger === 'AUTO' && !(await isPremiumTenant(user.tenantId))) {
      return fail(new Error('Premium automations require the Pro or Firm plan. Create it disabled, or upgrade.'));
    }
    // An enabled AUTO automation that sends must carry an explicit, re-accepted risk ack.
    const sends = b.trigger === 'AUTO' && hasSendingStep(b.steps);
    if (sends && b.enabled && (!b.riskAccepted || !b.riskAcknowledgement)) {
      return fail(new Error('Enabling an automation that auto-sends requires accepting responsibility: riskAccepted=true + riskAcknowledgement text.'));
    }

    const row = await queryOne<{ id: string }>(
      `insert into automation
        (tenant_id, name, description, enabled, trigger, steps,
         intents, min_confidence, require_no_attention, sender_domains, match_stages,
         risk_accepted, risk_acknowledgement, risk_accepted_by, risk_accepted_at, created_by)
       values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       returning id`,
      [
        user.tenantId,
        b.name,
        b.description ?? null,
        b.enabled,
        b.trigger,
        JSON.stringify(b.steps),
        b.intents,
        b.minConfidence,
        b.requireNoAttention,
        b.senderDomains,
        b.matchStages,
        sends ? b.riskAccepted : false,
        sends ? b.riskAcknowledgement ?? null : null,
        sends && b.riskAccepted ? user.userId : null,
        sends && b.riskAccepted ? new Date().toISOString() : null,
        user.userId,
      ]
    );
    if (b.trigger === 'MANUAL') await indexAutomation(user.tenantId, row!.id, b.name, b.description ?? null);

    await writeAudit({
      tenantId: user.tenantId,
      actorUserId: user.userId,
      actionType: 'AUTO_RULE_CREATED',
      actionStatus: 'SUCCESS',
      payload: { automationId: row!.id, trigger: b.trigger, enabled: b.enabled },
    });

    return ok({ id: row!.id });
  } catch (error) {
    return fail(error);
  }
}
