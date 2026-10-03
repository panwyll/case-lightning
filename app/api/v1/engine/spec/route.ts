import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { issueCatalogueForForms, machineSpec } from '@/lib/server/engine/spec';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The state machine as data — what /engine/map draws. Same for every backend and tenant.
 * `?part=issues` is what an issue's form needs (spec.ts issueCatalogueForForms), cached by the browser for a while.
 */
export async function GET(req: Request) {
  try {
    assertFeature('auth');
    await requireUser();
    if (new URL(req.url).searchParams.get('part') === 'issues') return ok({ issues: issueCatalogueForForms() }, { headers: { 'Cache-Control': 'private, max-age=600' } });
    return ok(machineSpec());
  } catch (error) {
    return fail(error);
  }
}
