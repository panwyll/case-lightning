import { NextRequest, NextResponse, after } from 'next/server';
import type Stripe from 'stripe';
import { assertFeature } from '@/lib/server/config';
import { constructEvent } from '@/lib/server/stripe';
import { query } from '@/lib/server/db';
import {
  ensureAccountByCustomer,
  getAccountByReferralCode,
  setReferrer,
  accrueCommission,
  clawbackByInvoice,
} from '@/lib/server/referrals';
import { recordSubscriptionEvent } from '@/lib/server/billing-events';
import { planForPriceIds } from '@/lib/server/billing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function accountByCustomer(customerId: string, email: string | null) {
  return ensureAccountByCustomer(customerId, email);
}

export async function POST(req: NextRequest) {
  try {
    assertFeature('billing');
  } catch {
    return NextResponse.json({ error: 'billing not configured' }, { status: 503 });
  }

  const sig = req.headers.get('stripe-signature');
  if (!sig) return NextResponse.json({ error: 'missing signature' }, { status: 400 });

  const raw = await req.text(); // raw body required for signature verification
  let event: Stripe.Event;
  try {
    event = constructEvent(raw, sig);
  } catch (e) {
    return NextResponse.json({ error: `signature verification failed: ${(e as Error).message}` }, { status: 400 });
  }

  // Verified — acknowledge fast, process out of band.
  after(async () => {
    try {
      switch (event.type) {
        case 'checkout.session.completed': {
          const s = event.data.object as Stripe.Checkout.Session;
          const customerId = typeof s.customer === 'string' ? s.customer : s.customer?.id;
          if (!customerId) break;
          const email = s.customer_details?.email ?? s.customer_email ?? null;
          const account = await accountByCustomer(customerId, email);
          await recordSubscriptionEvent({ accountId: account.id, stripeCustomerId: customerId, eventType: 'CHECKOUT', toStatus: 'active' });
          await query(
            `update billing_account set stripe_subscription_id = coalesce($1, stripe_subscription_id),
               status = 'active', email = coalesce(email, $2), updated_at = now() where id = $3`,
            [typeof s.subscription === 'string' ? s.subscription : s.subscription?.id ?? null, email, account.id]
          );
          // Bind referral from client_reference_id (the referrer's code).
          if (s.client_reference_id) {
            const referrer = await getAccountByReferralCode(s.client_reference_id);
            if (referrer) await setReferrer(account.id, referrer.id);
          }
          break;
        }

        case 'invoice.paid':
        case 'invoice.payment_succeeded': {
          const inv = event.data.object as Stripe.Invoice;
          const customerId = typeof inv.customer === 'string' ? inv.customer : inv.customer?.id;
          if (!customerId || !inv.id) break;
          const account = await accountByCustomer(customerId, inv.customer_email ?? null);
          await recordSubscriptionEvent({ accountId: account.id, stripeCustomerId: customerId, eventType: 'PAID', toStatus: 'active' });
          await query(`update billing_account set status = 'active', updated_at = now() where id = $1`, [account.id]);
          const line = inv.lines?.data?.[0];
          await accrueCommission({
            refereeAccountId: account.id,
            stripeInvoiceId: inv.id,
            periodStart: line?.period?.start ?? null,
            periodEnd: line?.period?.end ?? null,
          });
          break;
        }

        case 'invoice.payment_failed': {
          const inv = event.data.object as Stripe.Invoice;
          const customerId = typeof inv.customer === 'string' ? inv.customer : inv.customer?.id;
          if (customerId) {
            await recordSubscriptionEvent({ stripeCustomerId: customerId, eventType: 'PAST_DUE', toStatus: 'past_due' });
            await query(`update billing_account set status = 'past_due', updated_at = now() where stripe_customer_id = $1`, [customerId]);
          }
          break;
        }

        case 'invoice.voided':
        case 'invoice.marked_uncollectible': {
          const inv = event.data.object as Stripe.Invoice;
          if (inv.id) await clawbackByInvoice(inv.id);
          break;
        }

        case 'charge.refunded': {
          const charge = event.data.object as Stripe.Charge;
          const invoiceId = typeof charge.invoice === 'string' ? charge.invoice : charge.invoice?.id;
          if (invoiceId) await clawbackByInvoice(invoiceId);
          break;
        }

        case 'customer.subscription.updated':
        case 'customer.subscription.created': {
          const sub = event.data.object as Stripe.Subscription;
          const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
          // Scan every line — a Firm sub also carries the per-seat overage item, so
          // items[0] alone could be the seat price and misdetect the tier.
          const plan = planForPriceIds(sub.items?.data?.map((i) => i.price?.id) ?? []);
          if (customerId) {
            await recordSubscriptionEvent({ stripeCustomerId: customerId, eventType: 'SUBSCRIPTION', toStatus: sub.status, plan });
            await query(
              `update billing_account set status = $1, plan = $2, stripe_subscription_id = $3, updated_at = now()
               where stripe_customer_id = $4`,
              [sub.status, plan, sub.id, customerId]
            );
          }
          break;
        }

        case 'customer.subscription.deleted': {
          const sub = event.data.object as Stripe.Subscription;
          const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
          if (customerId) {
            await recordSubscriptionEvent({ stripeCustomerId: customerId, eventType: 'CANCELED', toStatus: 'canceled' });
            await query(`update billing_account set status = 'canceled', updated_at = now() where stripe_customer_id = $1`, [customerId]);
          }
          break;
        }
      }
    } catch (error) {
      console.error('[stripe webhook] processing failed', event.type, (error as Error).message);
    }
  });

  return NextResponse.json({ received: true });
}
