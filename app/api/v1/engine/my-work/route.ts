import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { engine } from '@/lib/server/engine/adapters';
import { buckets, matterWork, OWNER_LABEL, type WorkItem } from '@/lib/server/engine/work';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The personal work list (docs/caseload-ux.md §4): DO · WAITING · CHASE across this
 * person's whole caseload. Nothing here is stored — it is derived from the same state the
 * machine enforces, so it cannot drift from the cases, and nobody has to groom it.
 *
 * `all=1` (conveyancers / admins) widens it to the team's caseload for cover.
 */
export async function GET(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const q = z.object({ all: z.string().optional(), limit: z.coerce.number().min(1).max(500).optional() }).parse(Object.fromEntries(req.nextUrl.searchParams));
    const all = q.all === '1' && (user.role === 'ADMIN' || user.role === 'CONVEYANCER');
    const svc = engine();
    const [states, subflows] = await Promise.all([
      svc.eventStore.listStates(user.tenantId, { assignedTo: all ? null : user.userId, limit: q.limit ?? 300 }),
      svc.eventStore.loadSubflows(user.tenantId),
    ]);
    const now = new Date();
    const items: WorkItem[] = [];
    for (const { state, meta } of states) {
      items.push(...matterWork(state, now, { ...meta, subflows }).items);
    }
    return ok({ ...buckets(items), scope: all ? 'all' : 'mine', matters: states.length, ownerLabels: OWNER_LABEL });
  } catch (error) {
    return fail(error);
  }
}
