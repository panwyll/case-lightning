/**
 * Append-only subscription status history — the source for churn, retention and
 * MRR-movement analytics. The Stripe webhook calls recordSubscriptionEvent() at
 * each status transition (see app/api/v1/billing/webhook). Record it BEFORE the
 * billing_account status update so `from_status` captures the prior state.
 *
 * Best-effort: a failed write here must not break webhook processing.
 */
import { query, queryOne } from './db';

// Under per-case billing there is no recurring amount to attribute to a subscription
// event: revenue is the case meter (see v_case_revenue, migration 065). mrr_pennies is
// kept on the row for the historical views but is always 0 for the 'usage' plan.
const PLAN_MRR_PENNIES: Record<string, number> = { usage: 0 };

type SubEventType = 'CHECKOUT' | 'PAID' | 'PAST_DUE' | 'SUBSCRIPTION' | 'CANCELED';

export async function recordSubscriptionEvent(args: {
  accountId?: string | null;
  stripeCustomerId?: string | null;
  eventType: SubEventType;
  toStatus?: string | null;
  plan?: string | null;
  meta?: Record<string, unknown>;
}): Promise<void> {
  try {
    const acct = args.accountId
      ? await queryOne<{ id: string; tenant_id: string | null; status: string | null; plan: string | null }>(
          'select id, tenant_id, status, plan from billing_account where id = $1',
          [args.accountId]
        )
      : args.stripeCustomerId
      ? await queryOne<{ id: string; tenant_id: string | null; status: string | null; plan: string | null }>(
          'select id, tenant_id, status, plan from billing_account where stripe_customer_id = $1',
          [args.stripeCustomerId]
        )
      : null;

    const plan = args.plan ?? acct?.plan ?? null;
    const mrr = plan ? PLAN_MRR_PENNIES[plan] ?? 0 : 0;

    await query(
      `insert into subscription_event
        (billing_account_id, tenant_id, stripe_customer_id, event_type, from_status, to_status, plan, mrr_pennies, meta)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
      [
        acct?.id ?? null,
        acct?.tenant_id ?? null,
        args.stripeCustomerId ?? null,
        args.eventType,
        acct?.status ?? null,
        args.toStatus ?? null,
        plan,
        mrr,
        JSON.stringify(args.meta ?? {}),
      ]
    );
  } catch (err) {
    console.warn('[subscription_event] failed to record:', (err as Error).message);
  }
}
