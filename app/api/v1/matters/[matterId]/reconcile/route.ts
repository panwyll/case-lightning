/**
 * POST /api/v1/matters/[matterId]/reconcile
 * Build the cross-document reconciliation grid for a matter. Premium (pro/enterprise)
 * — expensive synthesis. Trial users of a premium tier get a few attempts.
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertMatterAccess } from '@/lib/server/guard';
import { assertEntitled, isPremiumTenant, canUseExpensiveFeature } from '@/lib/server/plan';
import { buildMatterReconciliation } from '@/lib/server/reconcile';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: Promise<{ matterId: string }> }) {
  try {
    assertFeature('auth');
    assertFeature('ai');
    const user = await requireUser();
    await assertEntitled(user.tenantId);
    const { matterId } = z.object({ matterId: z.string().uuid() }).parse(await params);
    await assertMatterAccess(user, matterId);

    if (!(await isPremiumTenant(user.tenantId))) {
      return fail(Object.assign(new Error('Matter reconciliation is a Pro/Enterprise feature.'), { status: 402 }));
    }
    const gate = await canUseExpensiveFeature(user.tenantId, 'RECONCILE');
    if (!gate.allowed) {
      return fail(
        Object.assign(new Error(`Trial limit reached (${gate.cap} reconciliations). Subscribe for unlimited.`), { status: 402 })
      );
    }

    const result = await buildMatterReconciliation(user, matterId);
    return ok({ ...result, trialUsed: gate.trialing ? gate.used + 1 : undefined, trialCap: gate.trialing ? gate.cap : undefined });
  } catch (error) {
    return fail(error);
  }
}
