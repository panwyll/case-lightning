/**
 * User-facing billing surface for a signed-in firm (tenant).
 *
 * Sits on top of the Stripe-backed `billing_account` model (see 005_referrals.sql)
 * and the referral ledger in referrals.ts. Two jobs:
 *   1. getBillingSummary  — everything the /account page renders in one round-trip:
 *      plan/status, team seats, referral code/link, credit balance, commissions.
 *   2. createBillingPortalSession — a Stripe-hosted "manage subscription" session
 *      (update card, switch plan, view invoices, cancel). We deliberately do NOT
 *      build those screens ourselves; Stripe maintains them.
 *
 * Plan changes and cancellation happen in the Stripe Billing Portal and flow back
 * via customer.subscription.* webhooks, so this module is read-mostly.
 */
import { config } from './config';
import { query } from './db';
import { stripe } from './stripe';
import { accountForUser } from './referrals';
import type { SessionUser } from './types';

/** A seat = an app_user belonging to the tenant. The 'team' plan is multi-seat. */
export interface Seat {
  email: string;
  displayName: string | null;
  role: string;
}

export interface BillingSummary {
  plan: string | null; // 'standard' | 'team' | null (no subscription yet)
  status: string; // trialing | active | past_due | canceled
  hasSubscription: boolean; // a Stripe customer exists → portal is available
  seats: Seat[];
  seatCount: number;
  // Referral / credit (mirrors /api/v1/referrals so /account is a single fetch).
  referralCode: string;
  referralLink: string;
  creditBalancePennies: number;
  currency: string;
  commissionPennies: number;
  referrals: { total: number; active: number };
  commissions: { accruedPennies: number; appliedPennies: number; clawedBackPennies: number };
}

export async function getBillingSummary(user: SessionUser): Promise<BillingSummary> {
  const account = await accountForUser(user.tenantId, user.email);

  const seats = await query<{ email: string; display_name: string | null; role: string }>(
    `select email, display_name, role from app_user where tenant_id = $1 order by created_at asc`,
    [user.tenantId]
  );

  const referees = await query<{ status: string }>(
    `select ba.status from referral_edge e join billing_account ba on ba.id = e.referee_account_id
     where e.referrer_account_id = $1`,
    [account.id]
  );

  const totals = await query<{ status: string; total: string }>(
    `select status, coalesce(sum(amount_pennies),0)::text as total
     from commission_ledger where referrer_account_id = $1 group by status`,
    [account.id]
  );
  const totalFor = (s: string) => Number(totals.find((t) => t.status === s)?.total ?? 0);

  const appUrl = config.appUrl.replace(/\/$/, '');
  return {
    plan: account.plan,
    status: account.status,
    hasSubscription: Boolean(account.stripe_customer_id),
    seats: seats.map((s) => ({ email: s.email, displayName: s.display_name, role: s.role })),
    seatCount: seats.length,
    referralCode: account.referral_code,
    referralLink: `${appUrl}/start-trial?ref=${account.referral_code}`,
    creditBalancePennies: account.credit_balance_pennies,
    currency: config.billingCurrency,
    commissionPennies: config.referralCommissionPennies,
    referrals: { total: referees.length, active: referees.filter((r) => r.status === 'active').length },
    commissions: {
      accruedPennies: totalFor('ACCRUED'),
      appliedPennies: totalFor('APPLIED'),
      clawedBackPennies: totalFor('CLAWED_BACK'),
    },
  };
}

/** Raised when the user has no Stripe customer yet (never subscribed) — the route
 *  maps this to a 409 so the client can send them to /start-trial instead. */
export class NoSubscriptionError extends Error {
  constructor() {
    super('No subscription to manage yet.');
    this.name = 'NoSubscriptionError';
  }
}

/**
 * Create a Stripe Billing Portal session for the signed-in firm and return its
 * URL. The customer is configured (in the Stripe dashboard) to allow plan
 * switching, payment-method updates, invoice history and cancellation.
 */
export async function createBillingPortalSession(user: SessionUser): Promise<string> {
  const account = await accountForUser(user.tenantId, user.email);
  if (!account.stripe_customer_id) throw new NoSubscriptionError();

  const session = await stripe().billingPortal.sessions.create({
    customer: account.stripe_customer_id,
    return_url: `${config.appUrl.replace(/\/$/, '')}/account`,
  });
  return session.url;
}

export type PlanKey = 'standard' | 'team';

/**
 * Resolve a subscription's plan from its Stripe price. Prefers an exact match
 * against the configured price IDs (robust to any pricing change); only falls
 * back to the price amount when the price isn't one we recognise (e.g. a future
 * annual price, a promo, or a legacy price), so a mis-set amount can't silently
 * flip a firm's tier. The £400 (40000p) boundary sits between Standard (£200)
 * and Team (£500).
 */
export function planForPrice(priceId: string | null | undefined, unitAmountPennies: number | null | undefined): PlanKey {
  if (priceId) {
    if (priceId === config.stripePriceTeam) return 'team';
    if (priceId === config.stripePriceStandard) return 'standard';
  }
  return (unitAmountPennies ?? 0) >= 40000 ? 'team' : 'standard';
}

/** Raised when STRIPE_PRICE_* env vars aren't configured → checkout 503s. */
export class PlanNotConfiguredError extends Error {
  constructor(plan: PlanKey) {
    super(`No Stripe price configured for the ${plan} plan.`);
    this.name = 'PlanNotConfiguredError';
  }
}

function priceFor(plan: PlanKey): string {
  const price = plan === 'team' ? config.stripePriceTeam : config.stripePriceStandard;
  if (!price) throw new PlanNotConfiguredError(plan);
  return price;
}

/**
 * Switch the signed-in firm to `plan`.
 *  - Existing subscriber → swap the subscription's price item in place (prorated),
 *    so an "Upgrade to Team" click takes effect immediately with no re-checkout.
 *    Returns { updated: true }.
 *  - No subscription yet → mint a Stripe Checkout session for that price (reusing
 *    the existing customer when there is one) and return its URL to redirect to.
 * Either way the customer.subscription.* / checkout.session webhooks reconcile
 * billing_account.plan, so this never writes plan state itself.
 */
export async function changePlan(
  user: SessionUser,
  plan: PlanKey,
  referrerCode?: string | null
): Promise<{ updated: true } | { url: string }> {
  const price = priceFor(plan);
  const account = await accountForUser(user.tenantId, user.email);
  const appUrl = config.appUrl.replace(/\/$/, '');

  // Existing active subscription → update the line item rather than re-subscribing.
  if (account.stripe_customer_id && account.status !== 'canceled') {
    const subs = await stripe().subscriptions.list({
      customer: account.stripe_customer_id,
      status: 'active',
      limit: 1,
    });
    const sub = subs.data[0];
    if (sub) {
      await stripe().subscriptions.update(sub.id, {
        items: [{ id: sub.items.data[0].id, price }],
        proration_behavior: 'create_prorations',
        cancel_at_period_end: false,
      });
      return { updated: true };
    }
  }

  // New subscriber (or previously canceled) → Checkout. Forward the *referrer's*
  // code (from the cl_ref cookie) as client_reference_id so the webhook can bind
  // the referral edge — mirroring /start-trial. Never the buyer's own code (that
  // would be a self-referral no-op), and only a real, different account's code.
  const ref = referrerCode?.toUpperCase().replace(/[^A-Z0-9]/g, '') || null;
  const clientReferenceId = ref && ref !== account.referral_code ? ref : undefined;

  const session = await stripe().checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price, quantity: 1 }],
    customer: account.stripe_customer_id ?? undefined,
    customer_email: account.stripe_customer_id ? undefined : user.email,
    client_reference_id: clientReferenceId,
    success_url: `${appUrl}/account?upgraded=1`,
    cancel_url: `${appUrl}/account`,
    allow_promotion_codes: true,
  });
  return { url: session.url! };
}
