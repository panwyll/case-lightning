import { NextResponse } from 'next/server';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { createBillingPortalSession, NoSubscriptionError } from '@/lib/server/billing';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Mint a Stripe Billing Portal session and return its URL. Stripe hosts the
// manage-subscription screens (card, plan switch, invoices, cancel); we just
// redirect there. assertFeature('billing') ensures Stripe is configured.
export async function POST() {
  try {
    assertFeature('billing');
    const user = await requireUser();
    const url = await createBillingPortalSession(user);
    return ok({ url });
  } catch (error) {
    if (error instanceof NoSubscriptionError) {
      // Never subscribed → no portal exists. Point the client at checkout.
      return NextResponse.json({ error: error.message, action: 'start-trial' }, { status: 409 });
    }
    return fail(error);
  }
}
