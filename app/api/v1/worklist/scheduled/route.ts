import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { listScheduled } from '@/lib/server/scheduledSend';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Pending deferred sends for the firm — powers the cancellable "scheduled" chips in the pane. */
export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const scheduled = await listScheduled(user.tenantId);
    return ok({ scheduled });
  } catch (error) {
    return fail(error);
  }
}
