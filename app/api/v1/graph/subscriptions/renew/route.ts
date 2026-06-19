import { NextRequest } from 'next/server';
import { assertFeature } from '@/lib/server/config';
import { query } from '@/lib/server/db';
import { renewSubscription } from '@/lib/server/graph';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SUB_MINUTES = 4000;

/**
 * Renews subscriptions expiring within 24h. Intended for a scheduled job (Vercel
 * Cron). Protected by CRON_SECRET when set; Vercel Cron sends it as a Bearer token.
 */
export async function GET(req: NextRequest) {
  try {
    assertFeature('graph');
    const secret = process.env.CRON_SECRET;
    if (secret && req.headers.get('authorization') !== `Bearer ${secret}`) {
      return fail(new Error('Unauthorized'));
    }

    const due = await query<{ id: string; user_id: string }>(
      `select id, user_id from graph_subscription where expires_at < now() + interval '24 hours'`
    );
    const newExpiry = new Date(Date.now() + SUB_MINUTES * 60_000).toISOString();
    let renewed = 0;
    for (const s of due) {
      try {
        await renewSubscription(s.user_id, s.id, newExpiry);
        await query(`update graph_subscription set expires_at = $1 where id = $2`, [newExpiry, s.id]);
        renewed++;
      } catch {
        // Likely the user's refresh token expired; drop the dead subscription.
        await query(`delete from graph_subscription where id = $1`, [s.id]);
      }
    }
    return ok({ checked: due.length, renewed });
  } catch (error) {
    return fail(error);
  }
}
