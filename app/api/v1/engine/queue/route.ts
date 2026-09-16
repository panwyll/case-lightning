import { NextRequest } from 'next/server';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { engine } from '@/lib/server/engine/adapters';
import { queueQuerySchema } from '@/lib/server/engine/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Addendum 3 §3 — the queue: one row per matter assigned to this handler (`all=1` for
 * every matter, admins/seniors), with the surfaced pending count and the oldest pending
 * decision, sorted by oldest pending (default) or target completion date. Shadow-mode
 * matters are off the queue unless `includeShadow=1` (the comparison view).
 */
export async function GET(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const q = queueQuerySchema.parse(Object.fromEntries(req.nextUrl.searchParams));
    const all = q.all === '1' && (user.role === 'ADMIN' || user.role === 'CONVEYANCER');
    const rows = await engine().eventStore.listQueue(user.tenantId, { assignedTo: all ? null : user.userId, sort: q.sort, includeShadow: q.includeShadow === '1', limit: q.limit });
    return ok({ rows, sort: q.sort, scope: all ? 'all' : 'mine' });
  } catch (error) {
    return fail(error);
  }
}
