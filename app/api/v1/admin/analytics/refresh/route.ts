import { NextRequest } from 'next/server';
import { assertFeature } from '@/lib/server/config';
import { query } from '@/lib/server/db';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Refreshes the `mv_usage_daily` analytics rollup. The live views don't depend on
 * it, so this is an optimisation for dashboards over large fact tables. Wire it to
 * a daily Vercel cron when volume warrants (kept off the cron list for now to stay
 * within the Hobby plan's cron limit). Protected by CRON_SECRET like the other crons.
 */
export async function GET(req: NextRequest) {
  try {
    assertFeature('db');
    const secret = process.env.CRON_SECRET;
    if (secret && req.headers.get('authorization') !== `Bearer ${secret}`) {
      return fail(new Error('Unauthorized'));
    }
    const startedAt = Date.now();
    await query('refresh materialized view mv_usage_daily');
    return ok({ refreshed: 'mv_usage_daily', tookMs: Date.now() - startedAt });
  } catch (error) {
    return fail(error);
  }
}
