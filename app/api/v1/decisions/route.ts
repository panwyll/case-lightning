import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { offeredOptions } from '@/lib/server/engine/rules';
import { onlyVisible } from '@/lib/server/access';
import { engine } from '@/lib/server/engine/adapters';
import { decisionSentence } from '@/lib/server/engine/work';

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
    const svc = engine();
    const decisions = await onlyVisible(user, await svc.eventStore.listPendingDecisions(user.tenantId, { matterId: q.matterId ?? null, limit: q.limit }));
    // Scoped to one case, each row carries its task sentence (the same words the Tasks page uses).
    const state = q.matterId ? await svc.getState(user.tenantId, q.matterId).catch(() => null) : null;
    return ok({ decisions: decisions.map((d) => ({ ...d, options: offeredOptions(d.kind, d.options), sourceOpenedByMe: d.openedBy.includes(user.userId), what: state && state.decisions[d.eventId] ? decisionSentence(state, state.decisions[d.eventId]) : null })) });
  } catch (error) {
    return fail(error);
  }
}
