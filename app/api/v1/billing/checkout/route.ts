import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { startSubscription, PlanNotConfiguredError } from '@/lib/server/billing';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Put the signed-in firm on the per-case plan (£100 per case). New subscribers get a
// Checkout URL to redirect to ({ url }); an already-subscribed firm gets
// ({ updated: true }) — there is only one plan, so there's nothing to switch to. A
// referrer code in the cl_ref cookie is forwarded so a first subscription via /account
// still credits the referrer (as /start-trial does). Any request body is ignored:
// older clients posted { plan }, which no longer means anything.
export async function POST() {
  try {
    assertFeature('billing');
    const user = await requireUser();
    const referrerCode = (await cookies()).get('cl_ref')?.value ?? null;
    return ok(await startSubscription(user, referrerCode));
  } catch (error) {
    if (error instanceof PlanNotConfiguredError) {
      return NextResponse.json({ error: error.message, action: 'Set STRIPE_PRICE_CASE.' }, { status: 503 });
    }
    return fail(error);
  }
}
