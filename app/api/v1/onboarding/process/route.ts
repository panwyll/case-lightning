import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { getActiveJob, advanceJob, isAutoAdvanceable } from '@/lib/server/onboarding';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Advance the caller's active onboarding job by exactly one bounded slice
 * (one Graph page, a clustering pass, a few proposals, or a few provisions).
 * The taskpane calls this in a loop until `done` is true. Keeping each call
 * small is what keeps the job within the serverless time budget.
 */
export async function POST() {
  try {
    assertFeature('auth');
    assertFeature('graph');
    assertFeature('ai');
    const user = await requireUser();

    const job = await getActiveJob(user.userId);
    if (!job) return ok({ status: 'IDLE', job: null, done: true });

    const fresh = await advanceJob(user, job);
    return ok({ status: fresh.status, job: fresh, done: !isAutoAdvanceable(fresh.status) });
  } catch (error) {
    return fail(error);
  }
}
