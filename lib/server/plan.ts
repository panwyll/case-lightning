/**
 * Plan tiers & capability gates.
 *
 * Internal keys are stable; the customer-facing names differ (see PLAN_LABEL in the
 * admin/account UIs): plus → "Solo", pro → "Pro", enterprise → "Firm".
 *
 *   plus       — "Go".   ENTRY TIER. £200/mo, single seat. Gets the premium features
 *                but on tight meters — the point is to like them and run out.
 *   pro        — "Pro".  £500/mo, single seat. Same features, room to actually work.
 *   enterprise — "Firm". £1,000/mo. The only multi-seat tier, and uncapped.
 *
 * The keys are historical (plus/pro/enterprise) and deliberately left alone: they are
 * written into billing_account rows and Stripe metadata, and renaming them would buy a
 * migration for no behavioural gain. Read them as Go/Pro/Firm.
 *
 * EVERY tier gets the premium features (auto-rules, unlimited onboarding lookback, AI
 * doc-template [[prompt]] fills) — the ladder is metered, not feature-gated. What Go
 * lacks is headroom: an email cap that bites two to three weeks in, and a heavy-LLM
 * cap of a couple of dozen doc fills. Team/multi-seat is the one true feature gate and
 * it requires Firm. When Stripe isn't configured (pilot / self-host) there's no billing
 * to check, so we grant the top tier — nothing is gated.
 */
import { config } from './config';
import { queryOne } from './db';
import type { UsageFeature } from './usage';

export type Plan = 'plus' | 'pro' | 'enterprise';

const PLANS: readonly Plan[] = ['plus', 'pro', 'enterprise'];
// Every paid tier gets the premium features; Go is limited by its meters, not by a
// feature wall. Kept as a set so a future non-premium tier stays easy to express.
const PREMIUM_PLANS = new Set<Plan>(['plus', 'pro', 'enterprise']);

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
    return { plan: 'enterprise', status: 'pilot', entitled: true, trialing: false, pilot: true, trialEndsAt: null };
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
  // Comp override (test / pilot / internal) — full tier access for free, above Stripe,
  // so a webhook resync can't clobber it. See migration 032.
  if (account?.comp_plan && PLANS.includes(account.comp_plan as Plan)) {
    return { plan: account.comp_plan as Plan, status: 'active', entitled: true, trialing: false, pilot: false, trialEndsAt: null };
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
  let plan = entitled && PLANS.includes(account?.plan as Plan) ? (account!.plan as Plan) : null;
  // A trial must be evaluable: if the subscription didn't resolve to a known tier,
  // grant Pro features rather than nothing, so auto-rules/doc AI can be tried. Volume
  // is still held down by the trial email cap and trialExpensiveCap — features, not
  // throughput. Without this a plan-less trial silently gets the free-tier experience.
  if (trialing && plan === null) plan = 'pro';
  return { plan, status, entitled, trialing, pilot: false, trialEndsAt };
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

/** Premium AI/automation (auto-rules, unlimited onboarding, AI doc fills): pro or enterprise. */
export async function isPremiumTenant(tenantId: string): Promise<boolean> {
  const plan = await getTenantPlan(tenantId);
  return plan !== null && PREMIUM_PLANS.has(plan);
}

/**
 * Monthly cap on emails processed (triage/analyse) for a plan. null = unlimited.
 *
 * A null plan means we could not resolve a tier (e.g. the Stripe price didn't match
 * a known price id). That must fail CLOSED to the entry-tier cap — treating "unknown"
 * as unlimited would hand the loosest quota to the least-identified accounts.
 */
export function emailMonthlyCap(plan: Plan | null): number | null {
  if (plan === null) return config.emailCapPlus > 0 ? config.emailCapPlus : null;
  const c = plan === 'plus' ? config.emailCapPlus : plan === 'pro' ? config.emailCapPro : config.emailCapEnterprise;
  return c && c > 0 ? c : null;
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
  // A trial is held to the lower of its evaluated tier's cap and the trial cap, so
  // trialing on an "unlimited" tier doesn't hand out unlimited volume.
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

/** Team / multi-seat: Firm only. Go and Pro are single-seat — this is the one
 *  genuine feature gate in the ladder, and the reason to move up from Pro. */
export async function hasTeamAccess(tenantId: string): Promise<boolean> {
  return (await getTenantPlan(tenantId)) === 'enterprise';
}

/**
 * Heavy-LLM calls (DOC_FILL) this tenant has made in the current calendar month —
 * the meter behind the Pro tier's usage cap. Reuses the usage_event fact stream.
 */
export async function heavyLlmCallsThisMonth(tenantId: string): Promise<number> {
  const row = await queryOne<{ n: number }>(
    `select count(*)::int as n from usage_event
     where tenant_id = $1 and event_type = 'DOC_FILL' and created_at >= date_trunc('month', now())`,
    [tenantId]
  );
  return row?.n ?? 0;
}

/**
 * Whether this tenant may make another heavy-LLM call right now. Enterprise (and
 * pilot mode) is uncapped; Pro is capped per month; non-premium plans never reach
 * here (the feature is gated upstream).
 */
export async function canUseHeavyLlm(tenantId: string): Promise<{ allowed: boolean; plan: Plan | null; capped: boolean }> {
  const billing = await getTenantBilling(tenantId);
  if (!billing.entitled) return { allowed: false, plan: null, capped: true };
  // Trial: a few attempts only — give a flavour without running up cost.
  if (billing.trialing) {
    const gate = await canUseExpensiveFeature(tenantId, 'DOC_FILL');
    return { allowed: gate.allowed, plan: billing.plan, capped: !gate.allowed };
  }
  // Firm is uncapped. Go and Pro each have a monthly ceiling — Go's is deliberately
  // small enough to run out on. NB the old `plan !== 'pro'` short-circuit would have
  // handed Go unlimited doc fills, which is the opposite of the intent.
  if (billing.plan === 'enterprise') return { allowed: true, plan: billing.plan, capped: false };
  const cap = billing.plan === 'plus' ? config.goHeavyLlmMonthlyCap : config.proHeavyLlmMonthlyCap;
  const used = await heavyLlmCallsThisMonth(tenantId);
  const allowed = used < cap;
  return { allowed, plan: billing.plan, capped: !allowed };
}
