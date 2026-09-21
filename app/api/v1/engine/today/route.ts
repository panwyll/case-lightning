import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { engine } from '@/lib/server/engine/adapters';
import { actionable, buckets, matterWork, type WorkItem } from '@/lib/server/engine/work';
import { HEALTH_RANK, type HealthBand, type HealthSummary } from '@/lib/server/engine/health';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The day's work (docs/caseload-ux.md §9) — the operating model the product is for.
 *
 * A conveyancer with two hundred matters should not open two hundred files. Every active
 * matter is evaluated against its events, its waiting timers, its deadlines, its blockers
 * and its outstanding decisions, and what comes back is three numbers and a list:
 *
 *   200 active · 23 need you today · 7 at risk · 170 progressing or waiting properly
 *
 * The three groups are disjoint, so they add up to the caseload: a matter that needs you
 * is not also counted as at risk.
 *
 * `end=1` returns the wind-down view instead: what is still open, what the timers will
 * chase tomorrow, and which dates land this week.
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

    interface Row { matterId: string; matterRef: string | null; propertyAddress: string | null; band: HealthBand; health: HealthSummary; items: WorkItem[] }
    const rows: Row[] = states.map(({ state, meta }) => {
      const w = matterWork(state, now, { ...meta, subflows });
      return { matterId: state.matterId, matterRef: meta.matterRef, propertyAddress: meta.propertyAddress, band: w.band, health: w.health, items: w.items };
    });

    const needsYou = rows.filter((r) => actionable(r.items).length > 0);
    const needsYouIds = new Set(needsYou.map((r) => r.matterId));
    // At risk but nothing to do about it today: the case is delayed, blocked or critical
    // and the next move is someone else's. Worth knowing; not worth opening.
    const atRisk = rows.filter((r) => !needsYouIds.has(r.matterId) && HEALTH_RANK[r.band] >= HEALTH_RANK.delayed);
    const progressing = rows.length - needsYou.length - atRisk.length;

    const items = needsYou.flatMap((r) => actionable(r.items));
    const order: Record<HealthBand, number> = { critical: 0, blocked: 1, delayed: 2, attention: 3, normal: 4 };
    const bucketOrder: Record<string, number> = { escalate: 0, chase: 1, do: 2, waiting: 3 };
    items.sort((a, b) => order[a.urgency] - order[b.urgency] || bucketOrder[a.bucket] - bucketOrder[b.bucket] || (b.sinceWorkingDays ?? 0) - (a.sinceWorkingDays ?? 0));

    // The wind-down: what is still open, what the timers will do next, what lands this week.
    const waiting = rows.flatMap((r) => r.items.filter((i) => i.bucket === 'waiting'));
    const endOfDay = {
      stillOpen: items.length,
      chasingTomorrow: waiting.filter((i) => i.chaseInWorkingDays != null && i.chaseInWorkingDays <= 1),
      datesThisWeek: rows.flatMap((r) => r.items.filter((i) => i.bucket === 'escalate' && i.escalatesInWorkingDays != null && i.escalatesInWorkingDays <= 5)),
      overdueWaiting: waiting.filter((i) => i.escalatesInWorkingDays != null && i.escalatesInWorkingDays <= 0),
    };

    return ok({
      counts: { active: rows.length, needsYouToday: needsYou.length, atRisk: atRisk.length, progressing },
      ...buckets(items),
      actions: items,
      risks: atRisk
        .sort((a, b) => order[a.band] - order[b.band])
        .map((r) => ({ matterId: r.matterId, matterRef: r.matterRef, propertyAddress: r.propertyAddress, band: r.band, headline: r.health.headline, why: r.health.why, suggested: r.health.suggested })),
      endOfDay,
      scope: all ? 'all' : 'mine',
    });
  } catch (error) {
    return fail(error);
  }
}
