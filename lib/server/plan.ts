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

export type Plan = 'plus' | 'pro' | 'enterprise';

const PLANS: readonly Plan[] = ['plus', 'pro', 'enterprise'];
const PREMIUM_PLANS = new Set<Plan>(['pro', 'enterprise']);

/** The tenant's active plan, or null when there's no active subscription. */
export async function getTenantPlan(tenantId: string): Promise<Plan | null> {
  if (!config.stripeSecretKey) return 'enterprise'; // billing not in play → full access
  const account = await queryOne<{ plan: string | null; status: string }>(
    `select plan, status from billing_account where tenant_id = $1 order by updated_at desc limit 1`,
    [tenantId]
  );
  if (!account || account.status !== 'active') return null;
  return PLANS.includes(account.plan as Plan) ? (account.plan as Plan) : null;
}

/** Premium AI/automation (auto-rules, unlimited onboarding, AI doc fills): pro or enterprise. */
export async function isPremiumTenant(tenantId: string): Promise<boolean> {
  const plan = await getTenantPlan(tenantId);
  return plan !== null && PREMIUM_PLANS.has(plan);
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
  const plan = await getTenantPlan(tenantId);
  if (plan !== 'pro') return { allowed: true, plan, capped: false }; // enterprise/pilot uncapped
  const used = await heavyLlmCallsThisMonth(tenantId);
  const allowed = used < config.proHeavyLlmMonthlyCap;
  return { allowed, plan, capped: !allowed };
}
