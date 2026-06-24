import { NextRequest } from 'next/server';
import { assertFeature } from '@/lib/server/config';
import { query } from '@/lib/server/db';
import { ensureSubscription } from '@/lib/server/subscriptions';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Keeps every opted-in user's inbox subscription alive. Intended for a daily
 * Vercel Cron, but the same self-heal also runs when a user opens the taskpane,
 * so a missed cron run no longer silently kills on-receipt triage.
 *
 * For each user who wants auto-triage, ensureSubscription() renews an expiring
 * subscription or RECREATES a missing/dead one (instead of just deleting it).
 * Protected by CRON_SECRET when set; Vercel Cron sends it as a Bearer token.
 */
export async function GET(req: NextRequest) {
  try {
    assertFeature('graph');
    const secret = process.env.CRON_SECRET;
    if (secret && req.headers.get('authorization') !== `Bearer ${secret}`) {
      return fail(new Error('Unauthorized'));
    }

    // Auto-triage is always on, so arm every Graph-connected user — not just rows
    // that already have a subscription — to also rebuild ones lost entirely.
    const users = await query<{ id: string; tenant_id: string }>(
      `select id, tenant_id from app_user where graph_refresh_token is not null`
    );

    let healthy = 0;
    let needsReconnect = 0;
    for (const u of users) {
      const status = await ensureSubscription(u.id, u.tenant_id);
      if (status.enabled) healthy++;
      else if (status.needsReconnect) needsReconnect++;
    }
    return ok({ checked: users.length, healthy, needsReconnect });
  } catch (error) {
    return fail(error);
  }
}
