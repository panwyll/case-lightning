import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { onlyVisible } from '@/lib/server/access';
import { engine } from '@/lib/server/engine/adapters';
import { rollup, HEALTH_LABEL } from '@/lib/server/engine/health';
import { LIFECYCLE_LABEL } from '@/lib/server/engine/graph';
import { untrackedCaseRows } from '@/lib/server/engine/untracked';
import { query } from '@/lib/server/db';

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
    // A matter the engine is watching in shadow mode is still a real case on the firm's
    // books — shadow hides the engine's conclusions, never the matter. Shown by default.
    const tracked = (
      await engine().eventStore.listQueue(user.tenantId, {
        assignedTo: q.mine === '1' ? user.userId : null,
        includeShadow: q.includeShadow !== '0',
        limit: q.limit ?? 300,
      })
    ).map((r) => ({ ...r, tracked: true as const }));
    // And every open matter the engine is NOT running — the caseload is the firm's matters,
    // not the engine's.
    const untracked = await untrackedCaseRows(user.tenantId, {
      assignedTo: q.mine === '1' ? user.userId : null,
      exclude: new Set(tracked.map((r) => r.matterId)),
      limit: q.limit ?? 300,
    });
    // The handler's name, so a list can say who rather than show an id.
    const ids = Array.from(new Set([...tracked, ...untracked].map((r) => r.assignedTo).filter((x): x is string => !!x)));
    const names = ids.length ? await query<{ id: string; name: string }>(`select id, coalesce(display_name, email) as name from app_user where tenant_id = $1 and id = any($2::uuid[])`, [user.tenantId, ids]).catch(() => []) : [];
    const nameOf = new Map(names.map((n) => [n.id, n.name]));
    const rows = await onlyVisible(user, [...tracked, ...untracked].map((r) => ({ ...r, assignedToName: r.assignedTo ? nameOf.get(r.assignedTo) ?? null : null })));
    return ok({
      rows,
      // Health is only claimed for matters the engine actually knows about. An untracked
      // matter is not "moving normally" — it is unknown — so it is counted separately.
      rollup: { ...rollup(tracked.filter((r) => rows.some((x) => x.matterId === r.matterId)).map((r) => r.health.band)), untracked: rows.filter((r) => !r.tracked).length },
      scope: q.mine === '1' ? 'mine' : 'all',
      labels: { health: HEALTH_LABEL, lifecycle: LIFECYCLE_LABEL },
    });
  } catch (error) {
    return fail(error);
  }
}
