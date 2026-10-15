import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { query } from '@/lib/server/db';
import { engine } from '@/lib/server/engine/adapters';
import { firmSettings, latestScan } from '@/lib/server/workload/scan';
import { DEFAULT_SETTINGS, TIMED_RANGE, workingWeeks } from '@/lib/server/workload/model';
import { buildMeasurement, type PersonScan } from '@/lib/server/epa/measure';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The onboarding measurement (docs/epa-categories.md): the firm's typical week from everyone's latest finished scan, and
 * your own scan's state. Never one person's figures: how many of the team have been scanned, not who scored what.
 */
export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const scans = await query<{ id: string; user_id: string; since: Date; until: Date; intouch: PersonScan['intouch'] }>(
      `select distinct on (user_id) id, user_id, since, until, intouch from workload_scan
        where tenant_id = $1 and status in ('CHECKING', 'COMPLETE') order by user_id, created_at desc`, [user.tenantId]
    ).catch(() => []);
    const [settings, levels, team, mine] = await Promise.all([
      firmSettings(user.tenantId),
      engine().eventStore.loadLevels(user.tenantId),
      query<{ n: number }>(`select count(*)::int as n from app_user where tenant_id = $1 and role <> 'ASSISTANT'`, [user.tenantId]),
      latestScan(user.userId),
    ]);
    const people: PersonScan[] = [];
    for (const s of scans) {
      const [sent, received] = await Promise.all([
        query<{ category: string; roles: string[]; count: number; timed: number; median: number | null }>(
          `select category, recipient_roles as roles, count(*)::int as count,
                  count(*) filter (where m between $2 and $3)::int as timed,
                  percentile_cont(0.5) within group (order by m) filter (where m between $2 and $3) as median
             from (select category, recipient_roles, extract(epoch from (sent_at - drafted_at)) / 60 as m
                     from workload_email where scan_id = $1 and direction = 'out' and filtered is null and category is not null) e
            group by category, recipient_roles`, [s.id, TIMED_RANGE[0], TIMED_RANGE[1]]
        ),
        query<{ category: string; roles: string[]; count: number }>(
          `select category, recipient_roles as roles, count(*)::int as count from workload_email
            where scan_id = $1 and direction = 'in' and filtered is null and category is not null group by category, recipient_roles`, [s.id]
        ),
      ]);
      people.push({
        weeks: workingWeeks(new Date(s.since).toISOString(), new Date(s.until).toISOString()),
        sent: sent.map((g) => ({ category: g.category, roles: g.roles ?? [], count: g.count, timed: g.timed, timedMedianMinutes: g.median == null ? null : Number(g.median) })),
        received: received.map((g) => ({ category: g.category, roles: g.roles ?? [], count: g.count })),
        intouch: s.intouch ?? null,
      });
    }
    const contracted = Number(settings.contractedHours ?? DEFAULT_SETTINGS.contractedHours);
    return ok({
      measurement: buildMeasurement({ people, contractedHours: contracted, levels }),
      team: team[0]?.n ?? 0,
      scanned: people.length,
      mine: mine && { status: mine.status, messagesRead: mine.messages_read, classified: mine.classified, since: mine.since, until: mine.until, error: mine.error },
    });
  } catch (e) {
    return fail(e);
  }
}
