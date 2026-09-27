import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireRole } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { writeAudit } from '@/lib/server/audit';
import { retireSandboxMatter } from '@/lib/server/engine/sandbox';
import { stepScenario } from '@/lib/server/engine/scenarios/runner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Retire a sandbox case: it leaves every list; the log stays (append-only). Refuses a real matter. */
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ matterId: string }> }) {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    const { matterId } = z.object({ matterId: z.string().uuid() }).parse(await params);
    const r = await retireSandboxMatter(user.tenantId, matterId);
    if (!r.retired) return fail(Object.assign(new Error('Not a sandbox case.'), { status: 409 }));
    await writeAudit({ tenantId: user.tenantId, matterId, actorUserId: user.userId, actionType: 'SANDBOX_CASE_RETIRED', actionStatus: 'SUCCESS', payload: { matterId } }).catch(() => {});
    return ok(r);
  } catch (error) {
    return fail(error);
  }
}

/** Next Step on a stepping sandbox case. */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ matterId: string }> }) {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    const { matterId } = z.object({ matterId: z.string().uuid() }).parse(await params);
    const r = await stepScenario({ tenantId: user.tenantId, userId: user.userId, matterId });
    if (r.ran) await writeAudit({ tenantId: user.tenantId, matterId, actorUserId: user.userId, actionType: 'SANDBOX_SCENARIO_STEP', actionStatus: 'SUCCESS', payload: { step: r.ran.id, index: r.index, total: r.total } }).catch(() => {});
    return ok(r);
  } catch (error) {
    return fail(error);
  }
}
