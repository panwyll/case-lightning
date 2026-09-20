import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertMatterAccess } from '@/lib/server/guard';
import { ok, fail } from '@/lib/server/http';
import { engine } from '@/lib/server/engine/adapters';
import { caseGraph, gate, gatesFor, lifecycle, lifecycleFor, nextActions, requirements, whyNot, workstreams, LIFECYCLE_LABEL } from '@/lib/server/engine/graph';
import { profileOf } from '@/lib/server/engine/transactions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The case model as data (docs/case-model.md): the coarse lifecycle, the concurrent
 * workstreams, every requirement with its completion authority and what it is waiting
 * on, the gates, the next actions and the dependency graph. All projected from the
 * same state the machine enforces — the two UI views draw from this.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ matterId: string }> }) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const { matterId } = z.object({ matterId: z.string().uuid() }).parse(await params);
    await assertMatterAccess(user, matterId);
    const state = await engine().getState(user.tenantId, matterId);
    const now = new Date();
    const lc = lifecycle(state);
    const profile = profileOf(state.transactionType);
    const gates = gatesFor(state);
    return ok({
      profile: { type: profile.type, label: profile.label, side: profile.side, hasExchange: profile.hasExchange, stages: profile.stages, stageLabels: profile.stageLabels, lifecycle: lifecycleFor(profile), gates, counterparty: profile.counterparty },
      lifecycle: { id: lc, label: LIFECYCLE_LABEL[lc], stage: state.stage },
      workstreams: workstreams(state, now),
      requirements: requirements(state),
      gates: Object.fromEntries(gates.map((g) => [g, gate(state, g)])),
      whyNotExchange: whyNot(state, gates[0]),
      nextActions: nextActions(state, now),
      graph: caseGraph(state, now),
    });
  } catch (error) {
    return fail(error);
  }
}
