import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { machineSpec } from '@/lib/server/engine/spec';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The state machine as data — what /engine/map draws. Same for every backend and tenant. */
export async function GET() {
  try {
    assertFeature('auth');
    await requireUser();
    return ok(machineSpec());
  } catch (error) {
    return fail(error);
  }
}
