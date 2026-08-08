import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { changePlan, PlanNotConfiguredError } from '@/lib/server/billing';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// 'plus' ("Solo", £39) is retired and no longer sellable — Pro is the entry tier.
// The key still exists in Plan/billing mappings so any legacy row resolves, but a
// new subscription can't be opened on it.
const Body = z.object({ plan: z.enum(['pro', 'enterprise']) });

// Change the signed-in firm's plan. Existing subscribers get an in-place,
// prorated swap ({ updated: true }); new subscribers get a Checkout URL to
// redirect to ({ url }). A referrer code in the cl_ref cookie is forwarded so a
// first subscription via /account still credits the referrer (as /start-trial does).
export async function POST(req: Request) {
  try {
    assertFeature('billing');
    const user = await requireUser();
    const { plan } = Body.parse(await req.json());
    const referrerCode = (await cookies()).get('cl_ref')?.value ?? null;
    return ok(await changePlan(user, plan, referrerCode));
  } catch (error) {
    if (error instanceof PlanNotConfiguredError) {
      return NextResponse.json(
        { error: error.message, action: 'Set STRIPE_PRICE_STANDARD / STRIPE_PRICE_TEAM.' },
        { status: 503 }
      );
    }
    return fail(error);
  }
}
