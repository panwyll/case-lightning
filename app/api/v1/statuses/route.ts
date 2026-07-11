import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { ensureDefaultStatuses, listStatuses } from '@/lib/server/statuses';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The firm's task-status palette — read by the taskpane task list. */
export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireUser();
    await ensureDefaultStatuses(user.tenantId);
    const statuses = await listStatuses(user.tenantId);
    return ok({ statuses });
  } catch (error) {
    return fail(error);
  }
}
