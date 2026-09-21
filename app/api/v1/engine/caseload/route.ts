import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { engine } from '@/lib/server/engine/adapters';
import { rollup, HEALTH_LABEL } from '@/lib/server/engine/health';
import { LIFECYCLE_LABEL } from '@/lib/server/engine/graph';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The caseload map (docs/caseload-ux.md §1): one token per matter, grouped by the coarse
 * lifecycle band, each carrying its health and the single line that explains it. Plus the
 * firm-level rollup the oversight strip shows ("74 active · 51 moving normally · …").
 *
 * `mine=1` narrows to the caller's own matters; the default is the whole team's caseload,
 * because the view exists to spot the handful that need someone.
 */
export async function GET(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const q = z
      .object({ mine: z.string().optional(), includeShadow: z.string().optional(), limit: z.coerce.number().min(1).max(500).optional() })
      .parse(Object.fromEntries(req.nextUrl.searchParams));
    const rows = await engine().eventStore.listQueue(user.tenantId, {
      assignedTo: q.mine === '1' ? user.userId : null,
      includeShadow: q.includeShadow === '1',
      limit: q.limit ?? 300,
    });
    return ok({
      rows,
      rollup: rollup(rows.map((r) => r.health.band)),
      scope: q.mine === '1' ? 'mine' : 'all',
      labels: { health: HEALTH_LABEL, lifecycle: LIFECYCLE_LABEL },
    });
  } catch (error) {
    return fail(error);
  }
}
