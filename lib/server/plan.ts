/**
 * Entitlement & capability gates.
 *
 * Billing is USAGE-BASED: one plan, £100 per case. There is no tier ladder any more —
 * every entitled firm gets the whole product (auto-rules, unlimited onboarding lookback,
 * AI doc fills, team/multi-seat) and pays per case CONVEYi does chargeable work on (see
 * lib/server/case-billing.ts for what counts as a case and when it's charged).
 *
 * The one plan key is 'usage'. billing_account.plan still carries it (and Stripe
 * metadata may carry the historical plus/pro/enterprise keys) — migration 065 remaps
 * old rows, and the gates below never branch on the key, only on entitlement.
 *
 * What still varies is ENTITLEMENT (may the firm use the app at all) and whether the
 * firm is on a TRIAL: trial firms get everything, but expensive AI work is capped so a
 * free trial can't run up cost, and a trial case is never charged. When Stripe isn't
 * configured (pilot / self-host) there's no billing to check, so nothing is gated.
 */
import { config } from './config';
import { queryOne } from './db';
import type { UsageFeature } from './usage';

export type Plan = 'usage';

/** The single plan key written to billing_account.plan. */
export const USAGE_PLAN: Plan = 'usage';

/** 402 — caller is signed in but has no active entitlement (trial ended / unpaid). */
export class EntitlementError extends Error {
  status = 402;
  constructor(msg = 'Your trial has ended — subscribe to keep using CONVEYi.') {
    super(msg);
  }
}

export interface TenantBilling {
  plan: Plan | null; // the tier whose features apply (active OR trialing)
  status: string; // active | trialing | past_due | canceled | none | pilot
  entitled: boolean; // may use the app at all
  trialing: boolean; // on a free trial → tier features but capped usage
  pilot: boolean; // no Stripe configured → full access, no billing
  trialEndsAt: string | null; // when a card-free trial runs out (null if not on one)
}

/**
 * One read of the tenant's billing posture. Entitlement (may they use the app) is
 * separate from the feature tier. A trial grants the CHOSEN tier's features so the
 * firm can evaluate it, but expensive AI work is capped (see canUseExpensiveFeature)
 * and backlog lookback is clamped. When Stripe isn't configured we're in pilot mode:
 * full access, nothing gated.
 *
 * Trials come from two places and behave identically once granted:
 *   - CARD-FREE (the signup path): a firm that has never subscribed is entitled for
 *     TRIAL_DAYS from tenant.created_at, with no payment details at all. This is what
 *     lets someone sign in, scan their own mailbox and see real matters before deciding.
 *   - STRIPE-MANAGED: a subscription in `trialing` (trial_period_days at checkout).
 * The card-free branch requires the ABSENCE of a billing_account row, so cancelling a
 * subscription can never hand a firm a second free trial.
 */
export async function getTenantBilling(tenantId: string): Promise<TenantBilling> {
  if (!config.stripeSecretKey) {
    return { plan: USAGE_PLAN, status: 'pilot', entitled: true, trialing: false, pilot: true, trialEndsAt: null };
  }
  // One read for both the subscription and the tenant's own trial clock. The lateral
  // keeps the "latest billing_account row" semantics the previous query had.
  const row = await queryOne<{
    plan: string | null;
    status: string | null;
    comp_plan: string | null;
    has_account: boolean;
    ever_subscribed: boolean;
    trial_ends_at: string | null;
    tenant_created_at: string;
  }>(
    `select b.plan, b.status, b.comp_plan, (b.tenant_id is not null) as has_account,
            (b.stripe_subscription_id is not null) as ever_subscribed,
            t.trial_ends_at, t.created_at as tenant_created_at
       from tenant t
       left join lateral (
         select tenant_id, plan, status, comp_plan, stripe_subscription_id from billing_account
         where tenant_id = t.id order by updated_at desc limit 1
       ) b on true
      where t.id = $1`,
    [tenantId]
  );
  const account = row?.has_account ? row : null;
  // Comp override (test / pilot / internal) — full access for free, above Stripe, so a
  // webhook resync can't clobber it. See migration 032. Any non-null value comps the
  // firm; cases opened by a comped firm are recorded but never reported to Stripe.
  if (account?.comp_plan) {
    return { plan: USAGE_PLAN, status: 'active', entitled: true, trialing: false, pilot: false, trialEndsAt: null };
  }
  let status = account?.status ?? 'none';
  let entitled = status === 'active' || status === 'trialing';
  let trialing = status === 'trialing';

  // Card-free trial: a firm that has NEVER subscribed gets full trial access from first
  // sign-in, so it can scan its own mailbox and see real matters before paying.
  //
  // The gate is "never had a Stripe SUBSCRIPTION", not "has no billing_account row":
  // accountForUser() inserts a row for every signed-in user so they get a referral code
  // (referrals.ts), so a row-based check would end the trial the moment they opened the
  // account page. Keying on stripe_subscription_id also means a cancelled subscriber
  // can't unsubscribe their way into a second free trial, while someone who abandoned
  // checkout (customer created, no subscription) keeps the trial they were promised.
  let trialEndsAt: string | null = null;
  if (!entitled && !row?.ever_subscribed && row) {
    const endsAt = row.trial_ends_at
      ? new Date(row.trial_ends_at)
      : new Date(new Date(row.tenant_created_at).getTime() + config.trialDays * 86_400_000);
    if (Date.now() < endsAt.getTime()) {
      entitled = true;
      trialing = true;
      // Report it as a trial, not as 'none' — the account panel and the upgrade nudges
      // key off this string, and 'none' would read as "no access" to a firm that has it.
      status = 'trialing';
      trialEndsAt = endsAt.toISOString();
    }
  }
  // One plan: entitled → 'usage', otherwise no plan. The stored key is irrelevant to
  // the gates (a pre-migration row may still say plus/pro/enterprise).
  const plan: Plan | null = entitled ? USAGE_PLAN : null;
  return { plan, status, entitled, trialing, pilot: false, trialEndsAt };
}

/**
 * Whole days left on the tenant's card-free trial, 0 once it has elapsed.
 *
 * Checkout uses this for trial_period_days instead of a flat config.trialDays. Without
 * it a firm that had already spent its 14 card-free days got a *second* 14-day Stripe
 * trial the moment it subscribed — 28 days free and revenue a fortnight late. Passing
 * the REMAINDER rather than a yes/no also means deciding early isn't punished: subscribe
 * on day 3 and Stripe carries the other 11 days, so the firm still gets exactly one
 * trial of exactly TRIAL_DAYS however it arrives at checkout.
 */
export async function trialDaysRemaining(tenantId: string): Promise<number> {
  const row = await queryOne<{ trial_ends_at: string | null; created_at: string }>(
    `select trial_ends_at, created_at from tenant where id = $1`,
    [tenantId]
  );
  if (!row) return 0;
  const endsAt = row.trial_ends_at
    ? new Date(row.trial_ends_at)
    : new Date(new Date(row.created_at).getTime() + config.trialDays * 86_400_000);
  const days = Math.ceil((endsAt.getTime() - Date.now()) / 86_400_000);
  return Math.max(0, days);
}

/** Whether the tenant may use the app at all (active subscription or live trial). */
export async function isEntitled(tenantId: string): Promise<boolean> {
  return (await getTenantBilling(tenantId)).entitled;
}

/** Throw a 402 when the tenant isn't entitled — the server-side box-out. */
export async function assertEntitled(tenantId: string): Promise<void> {
  if (!(await isEntitled(tenantId))) throw new EntitlementError();
}

/** The tier whose features apply — including during a trial. Null if not entitled. */
export async function getTenantPlan(tenantId: string): Promise<Plan | null> {
  return (await getTenantBilling(tenantId)).plan;
}

/**
 * Premium AI/automation (auto-rules, unlimited onboarding, AI doc fills). Under per-case
 * billing every entitled firm has it — kept as a named gate so call sites read as
 * intent and a future feature wall stays a one-line change.
 */
export async function isPremiumTenant(tenantId: string): Promise<boolean> {
  return isEntitled(tenantId);
}

/** Monthly cap on emails processed (triage/analyse) for a paying firm. null = unlimited. */
export function emailMonthlyCap(_plan: Plan | null): number | null {
  return config.emailCap > 0 ? config.emailCap : null;
}

/**
 * Where the tenant stands against its monthly email cap, plus the hours its drafting
 * has saved this month (for the upgrade nudge). Emails are metered by EMAIL_CLASSIFY
 * (one per email triaged); a cached re-open does no new work and isn't counted.
 */
export async function emailQuotaStatus(
  tenantId: string,
  // Callers that have already resolved the billing posture can pass it in rather than
  // making us re-query for it — /billing/account was resolving it twice per request.
  known?: TenantBilling
): Promise<{ allowed: boolean; used: number; cap: number | null; hoursSavedThisMonth: number; plan: Plan | null }> {
  const billing = known ?? (await getTenantBilling(tenantId));
  // A trial is held to the lower of the paid cap and the trial cap, so an unlimited
  // paid cap doesn't hand a free trial unlimited volume.
  const trialCap = billing.trialing && config.emailCapTrial > 0 ? config.emailCapTrial : null;
  const caps = [emailMonthlyCap(billing.plan), trialCap].filter((c): c is number => c != null);
  const cap = caps.length ? Math.min(...caps) : null;
  // Always meter, even when uncapped — the account panel and the upgrade nudge read
  // `used`/`hoursSavedThisMonth`, and short-circuiting made them report a flat zero.
  const row = await queryOne<{ emails: number; drafts: number }>(
    `select
       count(*) filter (where event_type = 'EMAIL_CLASSIFY')::int as emails,
       count(*) filter (where event_type = 'DRAFT_REPLY')::int   as drafts
     from usage_event
     where tenant_id = $1 and created_at >= date_trunc('month', now())`,
    [tenantId]
  );
  const used = row?.emails ?? 0;
  const hoursSavedThisMonth = Math.round(((row?.drafts ?? 0) * config.estimatedMinutesSavedPerReply) / 60);
  return { allowed: cap == null || used < cap, used, cap, hoursSavedThisMonth, plan: billing.plan };
}

/**
 * Expensive-feature gate for TRIAL users: give a flavour, don't run up cost. During
 * a trial each pricey feature (doc fills, matter reconciliation) is capped to a few
 * attempts; active subscribers pass through (their per-tier caps apply elsewhere).
 *
 * The window is ROLLING 14 days, not per-trial. That distinction didn't matter when the
 * trial was itself 14 days, but at TRIAL_DAYS=60 it means roughly trialExpensiveCap
 * attempts per fortnight (~12 across the trial) rather than 3 in total. Deliberate: a
 * trial long enough to span a real conveyance needs to allow more than three document
 * fills, while still pacing the spend.
 */
export async function canUseExpensiveFeature(
  tenantId: string,
  feature: UsageFeature
): Promise<{ allowed: boolean; trialing: boolean; used: number; cap: number }> {
  const billing = await getTenantBilling(tenantId);
  const cap = config.trialExpensiveCap;
  if (!billing.trialing) return { allowed: billing.entitled, trialing: false, used: 0, cap };
  const row = await queryOne<{ n: number }>(
    `select count(*)::int as n from usage_event
     where tenant_id = $1 and event_type = $2 and created_at >= now() - interval '14 days'`,
    [tenantId, feature]
  );
  const used = row?.n ?? 0;
  return { allowed: used < cap, trialing: true, used, cap };
}

/**
 * Team / multi-seat. There is no single-seat plan any more — a firm pays per case, not
 * per person — so every entitled firm may add colleagues.
 */
export async function hasTeamAccess(tenantId: string): Promise<boolean> {
  return isEntitled(tenantId);
}

/**
 * Whether this tenant may make another heavy-LLM call (DOC_FILL) right now. Paying
 * firms are uncapped — the case it's for is what they pay for. A trial gets a few
 * attempts (see canUseExpensiveFeature) so a free trial can't run up cost.
 */
export async function canUseHeavyLlm(tenantId: string): Promise<{ allowed: boolean; plan: Plan | null; capped: boolean }> {
  const billing = await getTenantBilling(tenantId);
  if (!billing.entitled) return { allowed: false, plan: null, capped: true };
  if (billing.trialing) {
    const gate = await canUseExpensiveFeature(tenantId, 'DOC_FILL');
    return { allowed: gate.allowed, plan: billing.plan, capped: !gate.allowed };
  }
  return { allowed: true, plan: billing.plan, capped: false };
}
