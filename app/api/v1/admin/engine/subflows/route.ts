import { NextRequest } from 'next/server';
import { assertFeature } from '@/lib/server/config';
import { requireRole } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { engine } from '@/lib/server/engine/adapters';
import { levelSchema } from '@/lib/server/engine/http';
import { writeAudit } from '@/lib/server/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Trust level per engine action (propose | assist | auto). Admin only; every change is audited. */
export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    return ok({ levels: await engine().levels(user.tenantId) });
  } catch (error) {
    return fail(error);
  }
}

export async function PUT(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    const input = levelSchema.parse(await req.json());
    const levels = await engine().eventStore.setLevel(user.tenantId, input.action, input.level, user.userId);
    await writeAudit({ tenantId: user.tenantId, matterId: null, actorUserId: user.userId, actionType: 'ENGINE_TRUST_LEVEL', actionStatus: 'SUCCESS', payload: input }).catch(() => {});
    return ok({ levels });
  } catch (error) {
    return fail(error);
  }
}
