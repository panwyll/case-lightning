import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { enrolAllOpen } from '@/lib/server/engine/enrol';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Put every open matter in the firm on the engine. Idempotent; the caseload calls it when it finds one that is not. */
export async function POST() {
  try {
    assertFeature('auth');
    const user = await requireUser();
    return ok(await enrolAllOpen(user.tenantId, user.userId));
  } catch (error) {
    return fail(error);
  }
}
