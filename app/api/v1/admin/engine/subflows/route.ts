import { NextRequest } from 'next/server';
import { assertFeature } from '@/lib/server/config';
import { requireRole } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { engine } from '@/lib/server/engine/adapters';
import { subflowStatusSchema } from '@/lib/server/engine/http';
import { writeAudit } from '@/lib/server/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Addendum 3 §2: per-sub-flow trust level (shadow | assist | autonomous). Admin only; every change is audited. */
export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    return ok({ subflows: await engine().subflows(user.tenantId) });
  } catch (error) {
    return fail(error);
  }
}

export async function PUT(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    const input = subflowStatusSchema.parse(await req.json());
    const subflows = await engine().eventStore.setSubflowStatus(user.tenantId, input.subFlow, input.status, user.userId);
    await writeAudit({ tenantId: user.tenantId, matterId: null, actorUserId: user.userId, actionType: 'ENGINE_SUBFLOW_STATUS', actionStatus: 'SUCCESS', payload: input }).catch(() => {});
    return ok({ subflows });
  } catch (error) {
    return fail(error);
  }
}
