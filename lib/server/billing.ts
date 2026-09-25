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
 * Billing is usage-based — one plan, £100 per case (see case-billing.ts for the
 * meter). Cancellation and card changes happen in the Stripe Billing Portal and flow
 * back via customer.subscription.* webhooks, so this module is read-mostly.
 */
import { config } from './config';
import { query } from './db';
import { stripe } from './stripe';
import { accountForUser } from './referrals';
import { getTenantBilling, emailQuotaStatus, trialDaysRemaining, USAGE_PLAN, type Plan } from './plan';
import { caseUsage, type CaseUsage } from './case-billing';
import type { SessionUser } from './types';
import { paths } from '../paths';

/** A seat = an app_user belonging to the tenant. Seats are free; the firm pays per case. */
export interface Seat {
  email: string;
  displayName: string | null;
  role: string;
}

export interface BillingSummary {
  plan: string | null; // 'usage' when entitled, null otherwise
  status: string; // trialing | active | past_due | canceled
  entitled: boolean; // may use the app at all (active/trialing/pilot)
  trialing: boolean; // on a free trial (tier features, capped usage)
  trialEndsAt: string | null; // end of a card-free trial, for the "N days left" nudge
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
  // This month's AI usage (mirrors emailQuotaStatus so /account renders it without a second call).
  usage: { used: number; cap: number | null; hoursSavedThisMonth: number };
  // Per-case billing: the advertised price and what this firm has opened.
  pricePerCasePennies: number;
  cases: CaseUsage;
}

export async function getBillingSummary(user: SessionUser): Promise<BillingSummary> {
  // The account row and the tenant's billing posture are the only things anything else
  // depends on, so resolve those two together and fan the rest out in parallel. This ran
  // as seven sequential round trips — the pane's plan badge waited for all of them.
  const [account, billing] = await Promise.all([
    accountForUser(user.tenantId, user.email),
    getTenantBilling(user.tenantId),
  ]);

  const [seats, referees, totals, quota, cases] = await Promise.all([
    query<{ email: string; display_name: string | null; role: string }>(
      `select email, display_name, role from app_user where tenant_id = $1 order by created_at asc`,
      [user.tenantId]
    ),
    query<{ status: string }>(
      `select ba.status from referral_edge e join billing_account ba on ba.id = e.referee_account_id
       where e.referrer_account_id = $1`,
      [account.id]
    ),
    query<{ status: string; total: string }>(
      `select status, coalesce(sum(amount_pennies),0)::text as total
       from commission_ledger where referrer_account_id = $1 group by status`,
      [account.id]
    ),
    // Pass the posture we just resolved — this used to re-resolve it internally.
    emailQuotaStatus(user.tenantId, billing),
    caseUsage(user.tenantId),
  ]);
  const totalFor = (s: string) => Number(totals.find((t) => t.status === s)?.total ?? 0);
  const appUrl = config.appUrl.replace(/\/$/, '');
  return {
    // Report the RESOLVED posture, not the raw billing_account row. A card-free trial has
    // no subscription, so the row still reads plan=null/status='none' while the firm is
    // genuinely entitled — showing that verbatim told a trialing firm it had no plan.
    plan: billing.plan ?? account.plan,
    status: billing.status === 'none' ? account.status : billing.status,
    entitled: billing.entitled,
    trialing: billing.trialing,
    trialEndsAt: billing.trialEndsAt,
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
    usage: { used: quota.used, cap: quota.cap, hoursSavedThisMonth: quota.hoursSavedThisMonth },
    pricePerCasePennies: config.casePricePennies,
    cases,
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

export type PlanKey = Plan;

/**
 * Resolve the plan from a subscription's price IDs. There is one plan, so this only
 * exists to keep the webhook honest: a subscription that doesn't carry the per-case
 * price (a legacy tier price, or a mis-set one) still resolves to 'usage' — the gates
 * never branch on the key — but we log it so a stale Stripe config gets noticed.
 */
export function planForPriceIds(priceIds: (string | null | undefined)[]): PlanKey {
  if (config.stripePriceCase && !priceIds.includes(config.stripePriceCase)) {
    console.warn('[billing] subscription carries no STRIPE_PRICE_CASE item:', priceIds.filter(Boolean).join(','));
  }
  return USAGE_PLAN;
}

/** Raised when STRIPE_PRICE_CASE isn't configured → checkout 503s. */
export class PlanNotConfiguredError extends Error {
  constructor() {
    super('No Stripe price configured for per-case billing.');
    this.name = 'PlanNotConfiguredError';
  }
}

/**
 * Put the signed-in firm on the per-case plan.
 *  - Already subscribed (active/trialing customer) → nothing to change; there is only
 *    one plan. Returns { updated: true } so the UI just refreshes.
 *  - No subscription yet → mint a Stripe Checkout session for the metered per-case
 *    price (reusing the existing customer when there is one) and return its URL.
 * The checkout.session / customer.subscription.* webhooks reconcile billing_account,
 * so this never writes plan state itself.
 */
export async function startSubscription(
  user: SessionUser,
  referrerCode?: string | null
): Promise<{ updated: true } | { url: string }> {
  const price = config.stripePriceCase;
  if (!price) throw new PlanNotConfiguredError();
  const account = await accountForUser(user.tenantId, user.email);
  const appUrl = config.appUrl.replace(/\/$/, '');

  if (account.stripe_customer_id && account.status !== 'canceled') {
    const subs = await stripe().subscriptions.list({
      customer: account.stripe_customer_id,
      status: 'active',
      limit: 1,
    });
    if (subs.data[0]) return { updated: true };
  }

  // New subscriber (or previously canceled) → Checkout. Forward the *referrer's*
  // code (from the cl_ref cookie) as client_reference_id so the webhook can bind
  // the referral edge — mirroring /start-trial. Never the buyer's own code (that
  // would be a self-referral no-op), and only a real, different account's code.
  const ref = referrerCode?.toUpperCase().replace(/[^A-Z0-9]/g, '') || null;
  const clientReferenceId = ref && ref !== account.referral_code ? ref : undefined;

  // Only ever hand over the trial the firm hasn't already used. Every tenant starts a
  // card-free trial at sign-in, so a flat config.trialDays here granted a SECOND one at
  // checkout. See trialDaysRemaining.
  const trialLeft = await trialDaysRemaining(user.tenantId);

  const session = await stripe().checkout.sessions.create({
    mode: 'subscription',
    // A metered price takes no quantity — usage arrives as meter events.
    line_items: [{ price }],
    customer: account.stripe_customer_id ?? undefined,
    customer_email: account.stripe_customer_id ? undefined : user.email,
    client_reference_id: clientReferenceId,
    success_url: `${appUrl}${paths.account}?upgraded=1`,
    cancel_url: `${appUrl}${paths.account}`,
    allow_promotion_codes: true,
    // Stripe owns the trial clock from here — it emits customer.subscription.updated as
    // the trial converts (trialing → active) or lapses, and the webhook writes that
    // status straight through. Cases opened while trialing are never reported (see
    // case-billing.ts), so a card-on-file trial is still free.
    ...(trialLeft > 0 ? { subscription_data: { trial_period_days: trialLeft } } : {}),
  });
  return { url: session.url! };
}
