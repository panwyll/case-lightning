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
import { query, queryOne } from './db';
import { stripe } from './stripe';
import { accountForUser } from './referrals';
import { getTenantBilling, emailQuotaStatus, type Plan } from './plan';
import type { SessionUser } from './types';

/** The Firm (enterprise) base price bundles this many seats; extras bill per-seat. */
export const FIRM_INCLUDED_SEATS = 3;

/** A seat = an app_user belonging to the tenant. Multi-seat needs the Enterprise plan. */
export interface Seat {
  email: string;
  displayName: string | null;
  role: string;
}

export interface BillingSummary {
  plan: string | null; // 'plus' | 'pro' | 'enterprise' | null (no subscription yet)
  status: string; // trialing | active | past_due | canceled
  entitled: boolean; // may use the app at all (active/trialing/pilot)
  trialing: boolean; // on a free trial (tier features, capped usage)
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

  const billing = await getTenantBilling(user.tenantId);
  const quota = await emailQuotaStatus(user.tenantId);
  const appUrl = config.appUrl.replace(/\/$/, '');
  return {
    plan: account.plan,
    status: account.status,
    entitled: billing.entitled,
    trialing: billing.trialing,
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
 * Resolve a subscription's plan from its Stripe price ID, matched against the
 * configured price IDs. With three tiers the amount is no longer a reliable
 * discriminator, so an unrecognised price falls back to the lowest tier (`plus`,
 * least privilege) rather than guessing — a mis-set price can never over-grant.
 */
export function planForPrice(priceId: string | null | undefined): PlanKey {
  if (priceId) {
    if (priceId === config.stripePriceEnterprise) return 'enterprise';
    if (priceId === config.stripePricePro) return 'pro';
    if (priceId === config.stripePricePlus) return 'plus';
  }
  return 'plus';
}

/**
 * Resolve the plan from ALL of a subscription's price IDs, not just the first line.
 * A Firm subscription carries two items — the base price and the per-seat overage
 * (STRIPE_PRICE_FIRM_SEAT) — so reading items[0] alone can land on the seat price and
 * misdetect the tier. We take the highest recognised base tier present; the seat price
 * matches none of the three base prices and is therefore ignored.
 */
export function planForPriceIds(priceIds: (string | null | undefined)[]): PlanKey {
  if (priceIds.includes(config.stripePriceEnterprise)) return 'enterprise';
  if (priceIds.includes(config.stripePricePro)) return 'pro';
  if (priceIds.includes(config.stripePricePlus)) return 'plus';
  return 'plus';
}

/** Billable seats = everyone who can actually use the product; READ_ONLY viewers are free. */
export async function billableSeatCount(tenantId: string): Promise<number> {
  const row = await queryOne<{ n: string }>(
    `select count(*)::text as n from app_user where tenant_id = $1 and role <> 'READ_ONLY'`,
    [tenantId]
  );
  return Number(row?.n ?? '0');
}

/**
 * Reconcile the Firm plan's per-seat overage line item with the tenant's real seat count.
 * The base Firm price includes FIRM_INCLUDED_SEATS; each seat beyond that is billed via the
 * separate per-unit STRIPE_PRICE_FIRM_SEAT price. No-op unless the tenant is on Firm with an
 * active subscription AND the seat price is configured — so firms at/below the included count,
 * non-Firm tiers, and installs without the seat price all bill flat, exactly as before.
 *
 * Best-effort and idempotent: it only calls Stripe when the desired quantity differs from
 * what's already on the subscription, so the resulting subscription.updated webhook converges
 * (no loop). Callers fire-and-forget — a Stripe hiccup must never block sign-in or role edits.
 */
export async function syncFirmSeats(tenantId: string): Promise<void> {
  const seatPrice = config.stripePriceFirmSeat;
  if (!seatPrice) return;

  const account = await queryOne<{ stripe_customer_id: string | null }>(
    `select stripe_customer_id from billing_account where tenant_id = $1 order by updated_at desc limit 1`,
    [tenantId]
  );
  if (!account?.stripe_customer_id) return;

  const subs = await stripe().subscriptions.list({ customer: account.stripe_customer_id, status: 'active', limit: 1 });
  const sub = subs.data[0];
  if (!sub) return;

  const billing = await getTenantBilling(tenantId);
  const desired =
    billing.plan === 'enterprise' ? Math.max(0, (await billableSeatCount(tenantId)) - FIRM_INCLUDED_SEATS) : 0;

  const existing = sub.items.data.find((it) => it.price?.id === seatPrice);
  const current = existing?.quantity ?? 0;
  if (desired === current) return;

  const item =
    desired === 0
      ? { id: existing!.id, deleted: true }
      : existing
        ? { id: existing.id, quantity: desired }
        : { price: seatPrice, quantity: desired };

  await stripe().subscriptions.update(sub.id, {
    items: [item],
    proration_behavior: 'create_prorations',
  });
}

/** Raised when STRIPE_PRICE_* env vars aren't configured → checkout 503s. */
export class PlanNotConfiguredError extends Error {
  constructor(plan: PlanKey) {
    super(`No Stripe price configured for the ${plan} plan.`);
    this.name = 'PlanNotConfiguredError';
  }
}

function priceFor(plan: PlanKey): string {
  const price =
    plan === 'enterprise' ? config.stripePriceEnterprise : plan === 'pro' ? config.stripePricePro : config.stripePricePlus;
  if (!price) throw new PlanNotConfiguredError(plan);
  return price;
}

/**
 * Switch the signed-in firm to `plan`.
 *  - Existing subscriber → swap the subscription's price item in place (prorated),
 *    so an "Upgrade to Pro/Enterprise" click takes effect immediately, no re-checkout.
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
      // Switching to/from Firm changes whether per-seat overage applies — reconcile it.
      // (Also drops the overage item on a downgrade away from Firm.) Best-effort.
      await syncFirmSeats(user.tenantId).catch(() => {});
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
