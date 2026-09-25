/**
 * Per-case billing — the metering behind "£100 per case".
 *
 * A firm is charged once per matter, the first time CONVEYi does CHARGEABLE work on
 * it. Chargeable = a user-initiated piece of work product: a drafted reply or status
 * update, a document review or fill, a generated doc pack, a matter reconcile. It is
 * deliberately NOT background triage — matching, classifying and summarising incoming
 * mail runs on every email the moment auto-triage is armed, and a backlog scan can
 * touch every matter in the mailbox; charging on that would bill a firm £100 × its
 * whole caseload for having installed the add-in. The firm pays when it uses the
 * product on a case, not when the product notices a case.
 *
 * Mechanics: usage.ts calls chargeCase() after every successful usage_event that
 * carries a matter_id and a chargeable feature. The insert into matter_charge is the
 * once-only rule (unique tenant+matter); if the row is new and the firm has a live
 * paid subscription we report ONE Stripe Billing Meter event for its customer id, with
 * the row id as the idempotency identifier. Stripe sums the events and invoices
 * monthly against the metered STRIPE_PRICE_CASE price. Trial, comped and pilot firms
 * get the row (so the account page can say "3 cases this month, free on trial") but
 * no meter event — a trial case is never charged, even after the firm subscribes.
 *
 * Best-effort throughout: a Stripe outage must never fail the user's draft. A failed
 * report is kept on the row (billed=false, unbilled_reason=ERROR) for retry by
 * retryUnbilledCases().
 */
import { config } from './config';
import { query, queryOne } from './db';
import { stripe } from './stripe';
import { getTenantBilling } from './plan';
import type { UsageFeature } from './usage';

/** Features whose first successful run on a matter opens (charges) the case. */
export const CHARGEABLE_FEATURES: ReadonlySet<UsageFeature> = new Set<UsageFeature>([
  'DRAFT_REPLY',
  'DRAFT_UPDATE',
  'DOC_REVIEW',
  'DOC_FILL',
  'RECONCILE',
]);

export function isChargeableFeature(feature: UsageFeature): boolean {
  return CHARGEABLE_FEATURES.has(feature);
}

interface ChargeRow {
  id: string;
  billed: boolean;
  unbilled_reason: string | null;
}

/**
 * Open the case for billing if it isn't already. Returns the outcome for logging;
 * callers ignore it. Never throws.
 */
export async function chargeCase(
  tenantId: string,
  matterId: string,
  feature: UsageFeature
): Promise<{ opened: boolean; billed: boolean; reason?: string }> {
  try {
    // Insert-if-absent IS the once-only rule. `returning` is empty on conflict.
    const inserted = await queryOne<{ id: string }>(
      `insert into matter_charge (tenant_id, matter_id, trigger_feature, amount_pennies)
       values ($1, $2, $3, $4)
       on conflict (tenant_id, matter_id) do nothing
       returning id`,
      [tenantId, matterId, feature, config.casePricePennies]
    );
    if (!inserted) return { opened: false, billed: false };
    const outcome = await reportToStripe(tenantId, inserted.id);
    return { opened: true, ...outcome };
  } catch (err) {
    console.warn('[case-billing] chargeCase failed:', (err as Error).message);
    return { opened: false, billed: false, reason: 'ERROR' };
  }
}

/**
 * Report one matter_charge row to Stripe as a meter event, or record why not. Split
 * from chargeCase so retryUnbilledCases can re-drive a row that failed.
 */
async function reportToStripe(tenantId: string, chargeId: string): Promise<{ billed: boolean; reason?: string }> {
  const skip = async (reason: string) => {
    await query(
      `update matter_charge set billed = false, unbilled_reason = $2, amount_pennies = 0 where id = $1`,
      [chargeId, reason]
    );
    return { billed: false, reason };
  };

  const billing = await getTenantBilling(tenantId);
  if (billing.pilot) return skip('PILOT');
  if (billing.trialing) return skip('TRIAL');
  if (!billing.entitled) return skip('NO_SUBSCRIPTION');

  const account = await queryOne<{ stripe_customer_id: string | null; comp_plan: string | null; stripe_subscription_id: string | null }>(
    `select stripe_customer_id, comp_plan, stripe_subscription_id from billing_account
      where tenant_id = $1 order by updated_at desc limit 1`,
    [tenantId]
  );
  if (account?.comp_plan) return skip('COMP');
  if (!account?.stripe_customer_id || !account.stripe_subscription_id) return skip('NO_SUBSCRIPTION');

  try {
    // identifier = our row id → Stripe dedupes a retried report of the same case.
    await stripe().billing.meterEvents.create({
      event_name: config.stripeCaseMeterEvent,
      identifier: chargeId,
      payload: { stripe_customer_id: account.stripe_customer_id, value: '1' },
    });
    await query(
      `update matter_charge
          set billed = true, unbilled_reason = null, stripe_error = null,
              stripe_customer_id = $2, stripe_meter_event_id = $1, billed_at = now(),
              amount_pennies = $3
        where id = $1`,
      [chargeId, account.stripe_customer_id, config.casePricePennies]
    );
    return { billed: true };
  } catch (err) {
    const msg = (err as Error).message;
    console.warn('[case-billing] meter event failed:', msg);
    await query(
      `update matter_charge set billed = false, unbilled_reason = 'ERROR', stripe_error = $2,
              stripe_customer_id = $3 where id = $1`,
      [chargeId, msg.slice(0, 500), account.stripe_customer_id]
    );
    return { billed: false, reason: 'ERROR' };
  }
}

/**
 * Re-drive charges whose Stripe report failed. Safe to run from a cron: the meter
 * event identifier is the row id, so a report that actually landed but whose
 * acknowledgement we lost is deduped by Stripe rather than double-billed.
 */
export async function retryUnbilledCases(limit = 100): Promise<{ retried: number; billed: number }> {
  const rows = await query<{ id: string; tenant_id: string }>(
    `select id, tenant_id from matter_charge where unbilled_reason = 'ERROR' order by charged_at asc limit $1`,
    [limit]
  );
  let billed = 0;
  for (const r of rows) {
    const out = await reportToStripe(r.tenant_id, r.id).catch(() => ({ billed: false }));
    if (out.billed) billed++;
  }
  return { retried: rows.length, billed };
}

export interface CaseUsage {
  /** Cases opened this calendar month (billed + free). */
  thisMonth: number;
  /** Of those, how many were reported to Stripe. */
  billedThisMonth: number;
  /** Pennies billed this month (billedThisMonth × price at the time). */
  billedPenniesThisMonth: number;
  /** Cases ever opened by this firm. */
  allTime: number;
}

/** What the account page shows: cases this month and what they came to. */
export async function caseUsage(tenantId: string): Promise<CaseUsage> {
  const row = await queryOne<{ month: number; billed: number; pennies: string; all_time: number }>(
    `select
       count(*) filter (where charged_at >= date_trunc('month', now()))::int as month,
       count(*) filter (where billed and charged_at >= date_trunc('month', now()))::int as billed,
       coalesce(sum(amount_pennies) filter (where billed and charged_at >= date_trunc('month', now())), 0)::text as pennies,
       count(*)::int as all_time
     from matter_charge where tenant_id = $1`,
    [tenantId]
  );
  return {
    thisMonth: row?.month ?? 0,
    billedThisMonth: row?.billed ?? 0,
    billedPenniesThisMonth: Number(row?.pennies ?? '0'),
    allTime: row?.all_time ?? 0,
  };
}
