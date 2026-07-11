import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { ensureDefaultStages, listStages } from '@/lib/server/stages';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The firm's pipeline stages — read by the board, taskpane and workflow UIs. */
export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireUser();
    await ensureDefaultStages(user.tenantId);
    return ok({ stages: await listStages(user.tenantId) });
  } catch (error) {
    return fail(error);
  }
}
