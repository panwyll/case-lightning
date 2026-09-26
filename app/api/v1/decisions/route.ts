import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { onlyVisible } from '@/lib/server/access';
import { engine } from '@/lib/server/engine/adapters';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The case-handler feed (component #6, "Spark Notes"): only decision events, oldest
 * first, each with its pre-digested summary, the source it cites and the options.
 * Nothing here is resolvable until the source has been opened (see ./[eventId]).
 */
export async function GET(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const q = z.object({ matterId: z.string().uuid().optional(), limit: z.coerce.number().int().positive().max(500).default(100) }).parse(Object.fromEntries(req.nextUrl.searchParams));
    const decisions = await onlyVisible(user, await engine().eventStore.listPendingDecisions(user.tenantId, { matterId: q.matterId ?? null, limit: q.limit }));
    return ok({ decisions: decisions.map((d) => ({ ...d, sourceOpenedByMe: d.openedBy.includes(user.userId) })) });
  } catch (error) {
    return fail(error);
  }
}
