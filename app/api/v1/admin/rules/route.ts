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

export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    const rules = await query(`select * from auto_rule where tenant_id = $1 order by created_at desc`, [user.tenantId]);
    return ok({ rules });
  } catch (error) {
    return fail(error);
  }
}

const ruleSchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean().default(false),
  intents: z.array(z.string()).default([]),
  minConfidence: z.number().min(0).max(1).default(0.9),
  requireNoAttention: z.boolean().default(true),
  senderDomains: z.array(z.string()).default([]),
  doCategorize: z.boolean().default(true),
  categoryLabel: z.string().optional(),
  doAssign: z.boolean().default(false),
  assignTo: z.string().uuid().optional(),
  doAppendTracker: z.boolean().default(true),
  replyMode: z.enum(['NONE', 'DRAFT', 'SEND']).default('NONE'),
  replyTemplateId: z.string().uuid().optional(),
  // Required to enable a SEND rule — the admin accepts responsibility every time.
  riskAccepted: z.boolean().default(false),
  riskAcknowledgement: z.string().optional(),
});

export async function POST(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    const b = ruleSchema.parse(await req.json());

    if (b.enabled && !(await isPremiumTenant(user.tenantId))) {
      return fail(new Error('Premium auto-rules require the Team plan. Create the rule disabled, or upgrade.'));
    }

    // A SEND rule that is enabled must carry an explicit, re-accepted risk ack.
    if (b.replyMode === 'SEND' && b.enabled && (!b.riskAccepted || !b.riskAcknowledgement)) {
      return fail(
        new Error(
          'Enabling an auto-SEND rule requires accepting responsibility: set riskAccepted=true and provide riskAcknowledgement text.'
        )
      );
    }

    const row = await queryOne<any>(
      `insert into auto_rule
        (tenant_id, name, enabled, intents, min_confidence, require_no_attention, sender_domains,
         do_categorize, category_label, do_assign, assign_to, do_append_tracker, reply_mode, reply_template_id,
         risk_accepted, risk_acknowledgement, risk_accepted_by, risk_accepted_at, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       returning *`,
      [
        user.tenantId,
        b.name,
        b.enabled,
        b.intents,
        b.minConfidence,
        b.requireNoAttention,
        b.senderDomains,
        b.doCategorize,
        b.categoryLabel ?? null,
        b.doAssign,
        b.assignTo ?? null,
        b.doAppendTracker,
        b.replyMode,
        b.replyTemplateId ?? null,
        b.replyMode === 'SEND' ? b.riskAccepted : false,
        b.replyMode === 'SEND' ? b.riskAcknowledgement ?? null : null,
        b.replyMode === 'SEND' && b.riskAccepted ? user.userId : null,
        b.replyMode === 'SEND' && b.riskAccepted ? new Date().toISOString() : null,
        user.userId,
      ]
    );

    await writeAudit({
      tenantId: user.tenantId,
      actorUserId: user.userId,
      actionType: 'AUTO_RULE_CREATED',
      actionStatus: 'SUCCESS',
      payload: { ruleId: row!.id, replyMode: b.replyMode, enabled: b.enabled, riskAccepted: b.riskAccepted },
    });

    return ok({ rule: row });
  } catch (error) {
    return fail(error);
  }
}
