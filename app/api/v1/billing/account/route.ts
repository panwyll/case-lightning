import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { getBillingSummary } from '@/lib/server/billing';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Everything the /account page renders: plan/status, seats, referral + credit.
export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireUser();
    return ok(await getBillingSummary(user));
  } catch (error) {
    return fail(error);
  }
}
