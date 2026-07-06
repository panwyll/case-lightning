/**
 * Referral graph + recurring commission ledger.
 *
 * Model: single-level. Each billing_account is referred by at most one other
 * account (the DAG is a forest of chains). Commission is £50/month per directly-
 * referred account, accrued when that referee PAYS an invoice and payable the
 * first of the following month, applied as account credit.
 *
 * Integrity guarantees:
 *  - no self-referral, no double-referral (unique referee), no cycles (ancestor walk);
 *  - accrual idempotent per (referrer, referee-invoice);
 *  - clawback on refund/void; apply step is a guarded status transition.
 */
import crypto from 'node:crypto';
import { query, queryOne, transaction } from './db';
import { config } from './config';
import { creditCustomerBalance } from './stripe';

export function generateReferralCode(): string {
  // 8-char uppercase base32-ish, unambiguous.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

function firstOfNextMonth(from = new Date()): string {
  return new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1)).toISOString();
}

export interface BillingAccount {
  id: string;
  tenant_id: string | null;
  email: string | null;
  stripe_customer_id: string | null;
  plan: string | null;
  status: string;
  referral_code: string;
  credit_balance_pennies: number;
}

/** Get-or-create a billing account for a Stripe customer, with a fresh referral code. */
export async function ensureAccountByCustomer(
  stripeCustomerId: string,
  email: string | null
): Promise<BillingAccount> {
  const existing = await queryOne<BillingAccount>(
    `select * from billing_account where stripe_customer_id = $1`,
    [stripeCustomerId]
  );
  if (existing) return existing;

  // A code collision is astronomically unlikely; retry a couple of times anyway.
  for (let i = 0; i < 3; i++) {
    try {
      const row = await queryOne<BillingAccount>(
        `insert into billing_account (stripe_customer_id, email, referral_code)
         values ($1,$2,$3) returning *`,
        [stripeCustomerId, email, generateReferralCode()]
      );
      return row!;
    } catch (e) {
      if (i === 2) throw e;
    }
  }
  throw new Error('Could not create billing account');
}

export async function getAccountByReferralCode(code: string): Promise<BillingAccount | null> {
  return queryOne<BillingAccount>(`select * from billing_account where referral_code = $1`, [code.toUpperCase()]);
}

/**
 * The billing account for a signed-in product user. Matches by tenant, else by
 * email (backfilling tenant_id so checkout-created accounts link to the tenant),
 * else creates one so every user has a shareable referral code (network effects)
 * even before they're a paying customer.
 */
export async function accountForUser(tenantId: string, email: string): Promise<BillingAccount> {
  const byTenant = await queryOne<BillingAccount>(`select * from billing_account where tenant_id = $1 limit 1`, [tenantId]);
  if (byTenant) return byTenant;

  const byEmail = await queryOne<BillingAccount>(`select * from billing_account where lower(email) = lower($1) limit 1`, [email]);
  if (byEmail) {
    if (!byEmail.tenant_id) {
      await query(`update billing_account set tenant_id = $1, updated_at = now() where id = $2`, [tenantId, byEmail.id]);
      byEmail.tenant_id = tenantId;
    }
    return byEmail;
  }

  const row = await queryOne<BillingAccount>(
    `insert into billing_account (tenant_id, email, referral_code) values ($1,$2,$3) returning *`,
    [tenantId, email, generateReferralCode()]
  );
  return row!;
}

/** True if `ancestorId` is an ancestor of `accountId` in the referral chain. */
async function isAncestor(ancestorId: string, accountId: string): Promise<boolean> {
  let currentId: string = accountId;
  for (let hops = 0; hops < 64; hops++) {
    const edge: { referrer_account_id: string } | null = await queryOne<{ referrer_account_id: string }>(
      `select referrer_account_id from referral_edge where referee_account_id = $1`,
      [currentId]
    );
    if (!edge) return false;
    if (edge.referrer_account_id === ancestorId) return true;
    currentId = edge.referrer_account_id;
  }
  return false;
}

/**
 * Bind a referrer to a referee. Returns false (no-op) if it would self-refer,
 * the referee is already referred, or it would create a cycle.
 */
export async function setReferrer(refereeAccountId: string, referrerAccountId: string): Promise<boolean> {
  if (refereeAccountId === referrerAccountId) return false;

  const already = await queryOne(`select 1 from referral_edge where referee_account_id = $1`, [refereeAccountId]);
  if (already) return false;

  // Cycle guard: the referrer must not sit below the referee in the chain.
  if (await isAncestor(refereeAccountId, referrerAccountId)) return false;

  await query(
    `insert into referral_edge (referrer_account_id, referee_account_id) values ($1,$2)
     on conflict (referee_account_id) do nothing`,
    [referrerAccountId, refereeAccountId]
  );
  return true;
}

/**
 * Accrue commission for a referee's paid invoice. Idempotent per (referrer,
 * invoice). No-op if the referee has no referrer.
 */
export async function accrueCommission(args: {
  refereeAccountId: string;
  stripeInvoiceId: string;
  amountPaidPennies?: number | null;
  periodStart?: number | null;
  periodEnd?: number | null;
}): Promise<void> {
  const edge = await queryOne<{ referrer_account_id: string }>(
    `select referrer_account_id from referral_edge where referee_account_id = $1`,
    [args.refereeAccountId]
  );
  if (!edge) return;

  // Commission is a share of what the referred firm actually paid this invoice, capped —
  // so it scales down on low tiers (a flat £50 would overpay a £39 Solo referee) and up
  // with Firm seat overage, while never exceeding the cap. A £0 invoice (trial) accrues
  // nothing; you only ever pay commission out of revenue you've collected.
  const paid = Math.max(0, args.amountPaidPennies ?? 0);
  const amount = Math.min(config.referralCommissionPennies, Math.round(paid * config.referralCommissionRate));
  if (amount <= 0) return;

  await query(
    `insert into commission_ledger
       (referrer_account_id, referee_account_id, stripe_invoice_id, period_start, period_end, amount_pennies, status, payable_at)
     values ($1,$2,$3,$4,$5,$6,'ACCRUED',$7)
     on conflict (referrer_account_id, stripe_invoice_id) do nothing`,
    [
      edge.referrer_account_id,
      args.refereeAccountId,
      args.stripeInvoiceId,
      args.periodStart ? new Date(args.periodStart * 1000).toISOString() : null,
      args.periodEnd ? new Date(args.periodEnd * 1000).toISOString() : null,
      amount,
      firstOfNextMonth(),
    ]
  );
}

/** Reverse commission(s) tied to a refunded/voided invoice. */
export async function clawbackByInvoice(stripeInvoiceId: string): Promise<void> {
  const rows = await query<{ id: string; status: string; referrer_account_id: string; amount_pennies: number }>(
    `select id, status, referrer_account_id, amount_pennies from commission_ledger where stripe_invoice_id = $1`,
    [stripeInvoiceId]
  );
  for (const c of rows) {
    if (c.status === 'ACCRUED' || c.status === 'PAYABLE') {
      await query(`update commission_ledger set status = 'CLAWED_BACK' where id = $1`, [c.id]);
    } else if (c.status === 'APPLIED') {
      // Already credited — record a compensating clawback against the balance.
      await transaction(async (client) => {
        await client.query(`update commission_ledger set status = 'CLAWED_BACK' where id = $1`, [c.id]);
        await client.query(
          `insert into credit_transaction (account_id, amount_pennies, kind, commission_id, note)
           values ($1,$2,'CLAWBACK',$3,$4)`,
          [c.referrer_account_id, -c.amount_pennies, c.id, `Clawback for invoice ${stripeInvoiceId}`]
        );
        await client.query(
          `update billing_account set credit_balance_pennies = credit_balance_pennies - $1, updated_at = now() where id = $2`,
          [c.amount_pennies, c.referrer_account_id]
        );
      });
    }
  }
}

/**
 * Apply all due commissions (payable_at reached) as account credit. Each is a
 * guarded status transition, so concurrent/replayed runs never double-credit.
 * Mirrors the credit to the Stripe customer balance when one exists.
 */
export async function applyPayableCommissions(): Promise<{ applied: number; pennies: number }> {
  const due = await query<{ id: string; referrer_account_id: string; amount_pennies: number }>(
    `update commission_ledger set status = 'APPLIED', applied_at = now()
     where id in (
       select id from commission_ledger
       where status in ('ACCRUED','PAYABLE') and payable_at <= now()
       for update skip locked
     )
     returning id, referrer_account_id, amount_pennies`
  );

  let pennies = 0;
  for (const c of due) {
    pennies += c.amount_pennies;
    const account = await queryOne<{ stripe_customer_id: string | null }>(
      `update billing_account set credit_balance_pennies = credit_balance_pennies + $1, updated_at = now()
       where id = $2 returning stripe_customer_id`,
      [c.amount_pennies, c.referrer_account_id]
    );
    let balanceTxnId: string | null = null;
    if (account?.stripe_customer_id) {
      try {
        balanceTxnId = await creditCustomerBalance(
          account.stripe_customer_id,
          c.amount_pennies,
          `CaseLightning referral commission`
        );
      } catch {
        /* internal balance is the source of truth; Stripe mirror is best-effort */
      }
    }
    await query(
      `insert into credit_transaction (account_id, amount_pennies, kind, commission_id, stripe_balance_txn_id, note)
       values ($1,$2,'COMMISSION',$3,$4,'Referral commission applied')`,
      [c.referrer_account_id, c.amount_pennies, c.id, balanceTxnId]
    );
  }
  return { applied: due.length, pennies };
}
