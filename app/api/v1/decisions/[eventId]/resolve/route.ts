import { assertEntitled } from '@/lib/server/plan';
import { NextRequest, after } from 'next/server';
import { withDeferredEffects } from '@/lib/server/engine/defer';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertMatterAccess } from '@/lib/server/guard';
import { ok, fail } from '@/lib/server/http';
import { engine } from '@/lib/server/engine/adapters';
import { stageBlockers } from '@/lib/server/engine/machine';
import { pendingDecisions } from '@/lib/server/engine/types';
import { requireDeciderFor, resolveSchema, assertEngaged } from '@/lib/server/engine/http';
import { decisionTask } from '@/lib/server/engine/work';
import { writeAudit } from '@/lib/server/audit';
import { queryOne } from '@/lib/server/db';
import { canAccessMatter } from '@/lib/server/access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** Resolve a pending decision. 412 if this user has not opened / engaged with the source; 400 without a reason for a non-approve action; 409 if it is no longer pending or the matter/sub-flow is in shadow. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ eventId: string }> }) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    // A suspended firm (unpaid past its grace) can read its cases but not act on them.
    await assertEntitled(user.tenantId);
    const { eventId } = z.object({ eventId: z.string().uuid() }).parse(await params);
    const input = resolveSchema.parse(await req.json());
    const svc = engine();
    const d = await svc.eventStore.findDecision(user.tenantId, eventId);
    if (!d) return fail(Object.assign(new Error('Decision not found.'), { status: 404 }));
    await assertMatterAccess(user, d.matterId);
    // An assistant may send what the engine drafted to move the file along; judgement and money stay with a conveyancer.
    if (user.role === 'ASSISTANT') {
      const st = await svc.getState(user.tenantId, d.matterId);
      const dec = st.decisions[eventId];
      requireDeciderFor(user, dec ? decisionTask(st, dec).kind : null);
    }
    // An escalation goes to a colleague who can open this case.
    if (input.option === 'escalate' && input.escalateTo) {
      const to = await queryOne<{ id: string; role: string }>(`select id, role from app_user where tenant_id = $1 and id = $2`, [user.tenantId, input.escalateTo]);
      if (!to || !(await canAccessMatter({ ...user, userId: to.id, role: to.role as never, caseAccess: undefined, mailboxAccess: undefined } as never, d.matterId))) return fail(Object.assign(new Error('That person cannot open this case. Choose someone who can.'), { status: 400 }));
    }
    // Addendum 3 §3: the engagement gate (scroll or dwell on the source) is checked here too, not only in the UI.
    // It guards decisions whose source is somebody else's document. A proposal or a held clear is the engine's own
    // text: the summary is the whole of it, so there is nothing to read before deciding.
    const engagement = d.kind === 'proposal' || d.kind === 'auto_clear' ? (input.engagement ?? { scrolledSource: false, dwellMs: 0 }) : assertEngaged(input.engagement ?? null);
    // Answer once the decision is recorded; what it sets off (drafting, sending) runs after the response.
    const result = await withDeferredEffects((work) => after(work), () => svc.resolveDecision(user.tenantId, d.matterId, eventId, user.userId, input.option, input.note ?? null, input.verification ?? null, engagement, input.selection ?? null, input.edited ?? null, input.escalateTo ?? null));
    await writeAudit({ tenantId: user.tenantId, matterId: d.matterId, actorUserId: user.userId, actionType: 'ENGINE_DECISION_RESOLVED', actionStatus: 'SUCCESS', payload: { decisionEventId: eventId, kind: d.kind, option: input.option, hasNote: !!input.note, verificationMethod: input.verification?.method ?? null, engagement, selection: input.selection ?? null } }).catch(() => {});
    return ok({ events: result.events, stage: result.state.stage, blockers: stageBlockers(result.state), pendingDecisions: pendingDecisions(result.state) });
  } catch (error) {
    return fail(error);
  }
}
