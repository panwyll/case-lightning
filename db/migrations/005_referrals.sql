-- Referral system: recurring single-level commission paid as account credit.
--
-- Robustness/integrity:
--  * the referral graph is a strict DAG — each account is referred at most once,
--    no self-referral, and assigning a referrer is cycle-checked.
--  * commission accrual is idempotent per (referee invoice) and tied to a PAID
--    invoice; refunds/voids claw back un-applied accruals.
--  * credit_balance_pennies on billing_account is the internal source of truth,
--    mirrored to the Stripe customer balance when a customer exists.

create table if not exists billing_account (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenant(id),          -- filled in when a product user authenticates
  email text,                                    -- billing email (links checkout → tenant)
  stripe_customer_id text unique,
  stripe_subscription_id text,
  plan text,                                      -- standard | team
  status text not null default 'trialing',        -- trialing | active | past_due | canceled
  referral_code text not null unique,             -- this account's shareable code
  credit_balance_pennies bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists billing_account_email_idx on billing_account (lower(email));
create index if not exists billing_account_tenant_idx on billing_account (tenant_id);

-- Each referee has exactly one referrer (single-level). The unique constraint on
-- referee_account_id enforces "referred at most once"; self-referral is blocked by
-- the check; deeper cycles are prevented in application code (referrals.ts).
create table if not exists referral_edge (
  id uuid primary key default gen_random_uuid(),
  referrer_account_id uuid not null references billing_account(id),
  referee_account_id uuid not null unique references billing_account(id),
  created_at timestamptz not null default now(),
  check (referrer_account_id <> referee_account_id)
);
create index if not exists referral_edge_referrer_idx on referral_edge (referrer_account_id);

-- One commission row per referee invoice. Idempotency is the unique (referrer,
-- stripe_invoice_id) pair — replayed webhooks never double-accrue.
create table if not exists commission_ledger (
  id uuid primary key default gen_random_uuid(),
  referrer_account_id uuid not null references billing_account(id),
  referee_account_id uuid not null references billing_account(id),
  stripe_invoice_id text not null,
  period_start timestamptz,
  period_end timestamptz,
  amount_pennies bigint not null,
  -- ACCRUED → PAYABLE (payable month reached) → APPLIED (credited); or CLAWED_BACK / VOID
  status text not null default 'ACCRUED',
  accrued_at timestamptz not null default now(),
  payable_at timestamptz not null,                -- first day of the month AFTER payment
  applied_at timestamptz,
  unique (referrer_account_id, stripe_invoice_id)
);
create index if not exists commission_status_idx on commission_ledger (status, payable_at);

-- Append-only record of credit movements against an account's balance.
create table if not exists credit_transaction (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references billing_account(id),
  amount_pennies bigint not null,                 -- +earned / -redeemed
  kind text not null,                             -- COMMISSION | CLAWBACK | REDEMPTION | ADJUST
  commission_id uuid references commission_ledger(id),
  stripe_balance_txn_id text,
  note text,
  created_at timestamptz not null default now()
);
create index if not exists credit_transaction_account_idx on credit_transaction (account_id, created_at desc);
