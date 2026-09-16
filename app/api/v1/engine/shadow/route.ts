import { assertFeature } from '@/lib/server/config';
import { requireRole } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { engine } from '@/lib/server/engine/adapters';
import { SUB_FLOWS } from '@/lib/server/engine/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Addendum 3 §2 — the rollout board (admins): every shadow-mode matter, each sub-flow's
 * trust level, and the agreement rate between engine conclusions and human handling
 * per sub-flow — the evidence for promoting a sub-flow from shadow to assist.
 */
export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    const svc = engine();
    const [subflows, reviews, queue] = await Promise.all([svc.subflows(user.tenantId), svc.eventStore.listShadowReviews(user.tenantId), svc.eventStore.listQueue(user.tenantId, { includeShadow: true, sort: 'oldest_pending', limit: 1000 })]);
    const perSubflow = SUB_FLOWS.map((sf) => {
      const rs = reviews.filter((r) => r.subFlow === sf);
      const agreed = rs.filter((r) => r.agrees).length;
      return { subFlow: sf, status: subflows[sf], reviewed: rs.length, agreed, disagreed: rs.length - agreed, agreementRate: rs.length ? agreed / rs.length : null };
    });
    return ok({
      subflows,
      perSubflow,
      shadowMatters: queue.filter((r) => r.shadowMode),
      liveMatters: queue.filter((r) => !r.shadowMode).length,
      totals: { reviewed: reviews.length, agreed: reviews.filter((r) => r.agrees).length },
    });
  } catch (error) {
    return fail(error);
  }
}
