import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireRole, requireUser } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { reviewedPlaybook, reviewRule } from '@/lib/server/playbook-review';
import { writeAudit } from '@/lib/server/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The playbook with this firm's review of each rule. Everyone may read; admins and conveyancers review. */
export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireUser();
    return ok({ rules: await reviewedPlaybook(user.tenantId) });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN', 'CONVEYANCER']);
    const b = z.object({ ruleId: z.string().min(3).max(120), status: z.enum(['approved', 'change_proposed']), proposal: z.string().max(5000).nullish() }).parse(await req.json());
    if (b.status === 'approved' && user.role !== 'ADMIN') throw Object.assign(new Error('An admin approves a rule; you can propose a change.'), { status: 403 });
    await reviewRule(user.tenantId, user.userId, b.ruleId, b.status, b.proposal ?? null);
    await writeAudit({ tenantId: user.tenantId, matterId: null, actorUserId: user.userId, actionType: 'PLAYBOOK_RULE_REVIEWED', actionStatus: 'SUCCESS', payload: { ruleId: b.ruleId, status: b.status } }).catch(() => {});
    return ok({ rules: await reviewedPlaybook(user.tenantId) });
  } catch (error) {
    return fail(error);
  }
}
