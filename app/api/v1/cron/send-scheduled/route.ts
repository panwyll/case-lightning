import { NextRequest } from 'next/server';
import { assertFeature } from '@/lib/server/config';
import { processDueSends } from '@/lib/server/scheduledSend';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Flush deferred sends whose grace window has elapsed. Backstop to the opportunistic
 * flush that runs on worklist load; intended for a Vercel Cron. Protected by CRON_SECRET
 * when set (Bearer token), mirroring the other cron routes.
 */
export async function GET(req: NextRequest) {
  try {
    assertFeature('auth');
    assertFeature('graph');
    const secret = process.env.CRON_SECRET;
    if (secret && req.headers.get('authorization') !== `Bearer ${secret}`) {
      return fail(new Error('Unauthorized'));
    }
    const result = await processDueSends();
    return ok(result);
  } catch (error) {
    return fail(error);
  }
}
