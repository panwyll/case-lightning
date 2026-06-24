import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { queryOne } from '@/lib/server/db';
import { isAutoTriageDesired } from '@/lib/server/subscriptions';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Status only. Auto-triage is always on (no opt-out) — arming/renewing the Graph
// subscription is handled by the on-open self-heal (/ensure) and the renew cron.
export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const [row, desired] = await Promise.all([
      queryOne<{ id: string; expires_at: string }>(
        `select id, expires_at from graph_subscription where user_id = $1 order by created_at desc limit 1`,
        [user.userId]
      ),
      isAutoTriageDesired(user.userId),
    ]);
    return ok({ enabled: Boolean(row), desired, subscriptionId: row?.id ?? null, expiresAt: row?.expires_at ?? null });
  } catch (error) {
    return fail(error);
  }
}
