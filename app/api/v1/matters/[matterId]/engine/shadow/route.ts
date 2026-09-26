import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertMatterAccess } from '@/lib/server/guard';
import { ok, fail } from '@/lib/server/http';
import { engine } from '@/lib/server/engine/adapters';
import { query, queryOne } from '@/lib/server/db';
import { requireDecider, shadowReviewSchema } from '@/lib/server/engine/http';
import { SUBFLOW_OF_KIND, type DecisionKind } from '@/lib/server/engine/types';
import { writeAudit } from '@/lib/server/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Addendum 3 §2 — the comparison view for one matter: what the ENGINE concluded (its
 * stage, every decision it raised including hidden ones, every action it would have
 * taken) side by side with what the HUMAN actually recorded (the legacy stage, tasks,
 * timeline), plus the reviews people have written against each engine conclusion.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ matterId: string }> }) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const { matterId } = z.object({ matterId: z.string().uuid() }).parse(await params);
    await assertMatterAccess(user, matterId);
    const svc = engine();
    const [state, events, subflows, reviews, matter, timeline, tasks] = await Promise.all([
      svc.getState(user.tenantId, matterId),
      svc.listEvents(user.tenantId, matterId),
      svc.subflows(user.tenantId),
      svc.eventStore.listShadowReviews(user.tenantId, matterId),
      queryOne<{ matter_ref: string; property_address: string; stage: string | null; stage_entered_at: Date | null; shadow_mode: boolean | null; handler: string | null }>(
        `select m.matter_ref, m.property_address, m.stage, m.stage_entered_at, m.shadow_mode, coalesce(u.display_name, u.email) as handler from matter m left join app_user u on u.id = m.assigned_to where m.id = $1 and m.tenant_id = $2`,
        [matterId, user.tenantId]
      ).catch(() => null),
      query<{ event_at: Date; event_type: string; title: string; details: string | null }>(`select event_at, event_type, title, details from matter_timeline_event where matter_id = $1 and tenant_id = $2 order by event_at desc limit 100`, [matterId, user.tenantId]).catch(() => []),
      query<{ ref: string; detail: string | null; status: string | null; created_at: Date }>(`select ref, detail, status, created_at from matter_task where matter_id = $1 and tenant_id = $2 order by created_at desc limit 100`, [matterId, user.tenantId]).catch(() => []),
    ]);
    const decisions = Object.values(state.decisions)
      .sort((a, b) => a.seq - b.seq)
      .map((d) => {
        const sf = SUBFLOW_OF_KIND[d.kind as DecisionKind];
        return { ...d, subFlow: sf, hiddenBy: state.shadowMode ? 'matter' : sf && subflows[sf] === 'shadow' ? 'subflow' : null, reviews: reviews.filter((r) => r.eventId === d.eventId) };
      });
    const suppressed = events.filter((e) => e.type === 'action_suppressed').map((e) => ({ eventId: e.id, seq: e.seq, at: e.createdAt, ...(e.payload as { action: string; reason: string; subFlow: string | null; detail: Record<string, unknown> }) }));
    const autoClears = events.filter((e) => /_cleared$/.test(e.type)).map((e) => ({ eventId: e.id, seq: e.seq, at: e.createdAt, type: e.type, actor: e.actor, subject: (e.payload as { searchType?: string; enquiryId?: string }).searchType ?? (e.payload as { enquiryId?: string }).enquiryId ?? null, reviews: reviews.filter((r) => r.eventId === e.id) }));
    const shadowModeChanges = events.filter((e) => e.type === 'shadow_mode_changed' || e.type === 'matter_created').map((e) => ({ at: e.createdAt, by: e.actor, shadowMode: (e.payload as { shadowMode?: boolean }).shadowMode ?? false, reason: (e.payload as { reason?: string | null }).reason ?? null }));
    return ok({
      matter: matter ? { matterRef: matter.matter_ref, propertyAddress: matter.property_address, handler: matter.handler, shadowMode: !!matter.shadow_mode } : null,
      engine: { stage: state.stage, stageHistory: state.stageHistory, shadowMode: state.shadowMode, decisions, suppressed, autoClears, blockersCount: 0 },
      human: { stage: matter?.stage ?? null, stageEnteredAt: matter?.stage_entered_at ?? null, timeline: timeline.map((t) => ({ at: t.event_at, type: t.event_type, title: t.title, details: t.details })), tasks: tasks.map((t) => ({ ref: t.ref, detail: t.detail, status: t.status, at: t.created_at })) },
      subflows,
      shadowModeChanges,
      reviews,
      summary: { conclusions: decisions.length + autoClears.length, reviewed: reviews.length, agreed: reviews.filter((r) => r.agrees).length, disagreed: reviews.filter((r) => !r.agrees).length, suppressed: suppressed.length },
    });
  } catch (error) {
    return fail(error);
  }
}

/** Record whether the engine's conclusion (a decision or an auto-clear) matched what the handler actually did. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ matterId: string }> }) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    requireDecider(user);
    const { matterId } = z.object({ matterId: z.string().uuid() }).parse(await params);
    await assertMatterAccess(user, matterId);
    const input = shadowReviewSchema.parse(await req.json());
    const svc = engine();
    const events = await svc.listEvents(user.tenantId, matterId);
    const target = events.find((e) => e.id === input.eventId);
    if (!target) return fail(Object.assign(new Error('That event is not on this case.'), { status: 404 }));
    const state = await svc.getState(user.tenantId, matterId);
    const d = state.decisions[input.eventId];
    const subFlow = d ? (SUBFLOW_OF_KIND[d.kind as DecisionKind] ?? d.kind) : target.type.replace(/_(cleared|flagged)$/, '').replace(/^(search|enquiry_reply|mortgage_offer|mortgage_condition|title|id_check).*/, (m) => (m.startsWith('enquiry') ? 'enquiry' : m.startsWith('mortgage') ? 'mortgage' : m));
    const review = await svc.eventStore.recordShadowReview({ tenantId: user.tenantId, matterId, eventId: input.eventId, subFlow, agrees: input.agrees, humanOutcome: input.humanOutcome ?? null, note: input.note ?? null, reviewer: user.userId });
    await writeAudit({ tenantId: user.tenantId, matterId, actorUserId: user.userId, actionType: 'ENGINE_SHADOW_REVIEW', actionStatus: 'SUCCESS', payload: { eventId: input.eventId, subFlow, agrees: input.agrees } }).catch(() => {});
    return ok({ review });
  } catch (error) {
    return fail(error);
  }
}
