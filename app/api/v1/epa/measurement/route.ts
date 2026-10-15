import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { query } from '@/lib/server/db';
import { latestScan, scanCounts } from '@/lib/server/workload/scan';
import { firmMeasurement } from '@/lib/server/epa/store';

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
    const [{ measurement, scanned }, team, mine] = await Promise.all([
      firmMeasurement(user.tenantId),
      query<{ n: number }>(`select count(*)::int as n from app_user where tenant_id = $1 and role <> 'ASSISTANT'`, [user.tenantId]),
      latestScan(user.userId),
    ]);
    return ok({
      measurement,
      team: team[0]?.n ?? 0,
      scanned,
      mine: mine && { status: mine.status, messagesRead: mine.messages_read, classified: mine.classified, since: mine.since, until: mine.until, error: mine.error, counts: await scanCounts(mine) },
    });
  } catch (e) {
    return fail(e);
  }
}
