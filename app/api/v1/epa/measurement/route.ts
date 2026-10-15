import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { query } from '@/lib/server/db';
import { engine } from '@/lib/server/engine/adapters';
import { firmSettings, latestScan, scanCounts } from '@/lib/server/workload/scan';
import { DEFAULT_SETTINGS, workingWeeks } from '@/lib/server/workload/model';
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
      // Each email with its time: the measurement places them on the person's day (lib/server/epa/measure.ts).
      const rows = await query<{ id: string; direction: 'out' | 'in'; sent_at: Date; drafted_at: Date | null; category: string; roles: string[] | null; conversation_id: string | null }>(
        `select id, direction, sent_at, drafted_at, category, recipient_roles as roles, conversation_id from workload_email
          where scan_id = $1 and filtered is null and category is not null`, [s.id]
      );
      const as = (r: (typeof rows)[number]) => ({ id: r.id, at: r.sent_at.getTime(), draftedAt: r.drafted_at ? r.drafted_at.getTime() : null, category: r.category, roles: r.roles ?? [], conversationId: r.conversation_id });
      people.push({
        weeks: workingWeeks(new Date(s.since).toISOString(), new Date(s.until).toISOString()),
        sent: rows.filter((r) => r.direction === 'out').map(as),
        received: rows.filter((r) => r.direction === 'in').map(as),
        intouch: s.intouch ?? null,
      });
    }
    const contracted = Number(settings.contractedHours ?? DEFAULT_SETTINGS.contractedHours);
    return ok({
      measurement: buildMeasurement({ people, contractedHours: contracted, levels, workday: { workdayStart: settings.workdayStart ?? DEFAULT_SETTINGS.workdayStart, workdayEnd: settings.workdayEnd ?? DEFAULT_SETTINGS.workdayEnd } }),
      team: team[0]?.n ?? 0,
      scanned: people.length,
      mine: mine && { status: mine.status, messagesRead: mine.messages_read, classified: mine.classified, since: mine.since, until: mine.until, error: mine.error, counts: await scanCounts(mine) },
    });
  } catch (e) {
    return fail(e);
  }
}
