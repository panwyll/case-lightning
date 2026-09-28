import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertMatterAccess } from '@/lib/server/guard';
import { ok, fail } from '@/lib/server/http';
import { engine } from '@/lib/server/engine/adapters';
import { stageBlockers } from '@/lib/server/engine/machine';
import { pendingDecisions } from '@/lib/server/engine/types';
import { requireDecider, resolveSchema, assertEngaged } from '@/lib/server/engine/http';
import { writeAudit } from '@/lib/server/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Resolve a pending decision. 412 if this user has not opened / engaged with the source; 400 without a reason for a non-approve action; 409 if it is no longer pending or the matter/sub-flow is in shadow. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ eventId: string }> }) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    requireDecider(user);
    const { eventId } = z.object({ eventId: z.string().uuid() }).parse(await params);
    const input = resolveSchema.parse(await req.json());
    const svc = engine();
    const d = await svc.eventStore.findDecision(user.tenantId, eventId);
    if (!d) return fail(Object.assign(new Error('Decision not found.'), { status: 404 }));
    await assertMatterAccess(user, d.matterId);
    // Addendum 3 §3: the engagement gate (scroll or dwell on the source) is checked here too, not only in the UI.
    // It guards decisions whose source is somebody else's document. A proposal or a held clear is the engine's own
    // text: the summary is the whole of it, so there is nothing to read before deciding.
    const engagement = d.kind === 'proposal' || d.kind === 'auto_clear' ? (input.engagement ?? { scrolledSource: false, dwellMs: 0 }) : assertEngaged(input.engagement ?? null);
    const result = await svc.resolveDecision(user.tenantId, d.matterId, eventId, user.userId, input.option, input.note ?? null, input.verification ?? null, engagement, input.selection ?? null, input.edited ?? null);
    await writeAudit({ tenantId: user.tenantId, matterId: d.matterId, actorUserId: user.userId, actionType: 'ENGINE_DECISION_RESOLVED', actionStatus: 'SUCCESS', payload: { decisionEventId: eventId, kind: d.kind, option: input.option, hasNote: !!input.note, verificationMethod: input.verification?.method ?? null, engagement, selection: input.selection ?? null } }).catch(() => {});
    return ok({ events: result.events, stage: result.state.stage, blockers: stageBlockers(result.state), pendingDecisions: pendingDecisions(result.state) });
  } catch (error) {
    return fail(error);
  }
}
