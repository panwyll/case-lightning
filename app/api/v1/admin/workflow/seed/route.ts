import { assertFeature } from '@/lib/server/config';
import { requireRole } from '@/lib/server/session';
import { ensureDefaultWorkflow } from '@/lib/server/workflow';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Load the default conveyancing workflow — used by the empty-state button to (re)populate. */
export async function POST() {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    await ensureDefaultWorkflow(user.tenantId, true);
    return ok({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
