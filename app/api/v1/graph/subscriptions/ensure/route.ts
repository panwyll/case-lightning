/**
 * POST /api/v1/graph/subscriptions/ensure
 *
 * Self-heal hook the taskpane calls on open: if the user wants auto-triage but
 * the Graph subscription is missing or expiring soon, renew or recreate it.
 * Cheap (DB-only) when auto-triage is off or the subscription is healthy, so it's
 * safe to call on every open. Never errors the open — returns status.
 */
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { ensureSubscription } from '@/lib/server/subscriptions';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const status = await ensureSubscription(user.userId, user.tenantId);
    return ok(status);
  } catch (error) {
    return fail(error);
  }
}
