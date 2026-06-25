/**
 * Plan tiers & capability gates.
 *
 *   plus       — entry. No premium AI/automation, single seat.
 *   pro        — premium AI/automation, single seat, heavy-LLM usage capped.
 *   enterprise — premium AI/automation + team (multi-seat), uncapped.
 *
 * Premium features (auto-rules, unlimited onboarding lookback, AI doc-template
 * [[prompt]] fills) require pro OR enterprise. Team/multi-seat requires enterprise.
 * When Stripe isn't configured (pilot / self-host) there's no billing to check, so
 * we grant the top tier — nothing is gated.
 */
import { config } from './config';
import { queryOne } from './db';
import type { UsageFeature } from './usage';

export type Plan = 'plus' | 'pro' | 'enterprise';

const PLANS: readonly Plan[] = ['plus', 'pro', 'enterprise'];
const PREMIUM_PLANS = new Set<Plan>(['pro', 'enterprise']);

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
}

/**
 * One read of the tenant's billing posture. Entitlement (may they use the app) is
 * separate from the feature tier. A trial grants the CHOSEN tier's features so the
 * firm can evaluate it, but expensive AI work is capped (see canUseExpensiveFeature)
 * and backlog lookback is clamped. When Stripe isn't configured we're in pilot mode:
 * full access, nothing gated.
 */
export async function getTenantBilling(tenantId: string): Promise<TenantBilling> {
  if (!config.stripeSecretKey) {
    return { plan: 'enterprise', status: 'pilot', entitled: true, trialing: false, pilot: true };
  }
  const account = await queryOne<{ plan: string | null; status: string; comp_plan: string | null }>(
    `select plan, status, comp_plan from billing_account where tenant_id = $1 order by updated_at desc limit 1`,
    [tenantId]
  );
  // Comp override (test / pilot / internal) — full tier access for free, above Stripe,
  // so a webhook resync can't clobber it. See migration 032.
  if (account?.comp_plan && PLANS.includes(account.comp_plan as Plan)) {
    return { plan: account.comp_plan as Plan, status: 'active', entitled: true, trialing: false, pilot: false };
  }
  const status = account?.status ?? 'none';
  const entitled = status === 'active' || status === 'trialing';
  const trialing = status === 'trialing';
  const plan = entitled && PLANS.includes(account?.plan as Plan) ? (account!.plan as Plan) : null;
  return { plan, status, entitled, trialing, pilot: false };
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

/** Team / multi-seat: enterprise only (pro and plus are single-seat). */
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
  if (billing.plan !== 'pro') return { allowed: true, plan: billing.plan, capped: false }; // enterprise uncapped
  const used = await heavyLlmCallsThisMonth(tenantId);
  const allowed = used < config.proHeavyLlmMonthlyCap;
  return { allowed, plan: billing.plan, capped: !allowed };
}
