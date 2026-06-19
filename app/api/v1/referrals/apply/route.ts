import { NextRequest } from 'next/server';
import { assertFeature } from '@/lib/server/config';
import { applyPayableCommissions } from '@/lib/server/referrals';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Applies all due referral commissions as account credit. Scheduled monthly
 * (Vercel Cron) so commissions land "the month after" the referee paid. Protected
 * by CRON_SECRET when set (Vercel Cron sends it as a Bearer token).
 */
export async function GET(req: NextRequest) {
  try {
    assertFeature('billing');
    const secret = process.env.CRON_SECRET;
    if (secret && req.headers.get('authorization') !== `Bearer ${secret}`) {
      return fail(new Error('Unauthorized'));
    }
    const result = await applyPayableCommissions();
    return ok(result);
  } catch (error) {
    return fail(error);
  }
}
