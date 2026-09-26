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
 * `all=1` (conveyancers / admins) widens it to the team's caseload for cover; `user=<id>`
 * shows one colleague's, for the same people.
 */
export async function GET(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const q = z.object({ all: z.string().optional(), user: z.string().uuid().optional(), limit: z.coerce.number().min(1).max(500).optional() }).parse(Object.fromEntries(req.nextUrl.searchParams));
    const cover = user.role === 'ADMIN' || user.role === 'CONVEYANCER';
    const all = q.all === '1' && cover;
    const who = q.user && (cover || q.user === user.userId) ? q.user : user.userId;
    const svc = engine();
    const [states, subflows] = await Promise.all([
      svc.eventStore.listStates(user.tenantId, { assignedTo: all ? null : who, limit: q.limit ?? 300 }),
      svc.eventStore.loadLevels(user.tenantId),
    ]);
    const now = new Date();
    const items: WorkItem[] = [];
    for (const { state, meta } of states) {
      items.push(...matterWork(state, now, { ...meta, levels: subflows }).items);
    }
    return ok({ ...buckets(items), scope: all ? 'all' : who === user.userId ? 'mine' : 'colleague', matters: states.length, ownerLabels: OWNER_LABEL });
  } catch (error) {
    return fail(error);
  }
}
