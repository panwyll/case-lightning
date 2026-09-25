-- Usage-based billing: one plan, £100 per case.
--
-- The Go/Pro/Firm ladder is gone. Every entitled firm gets the whole product and pays
-- per case CONVEYi does chargeable work on. A case is charged ONCE, the first time a
-- chargeable feature (a draft, a document, a reconcile) runs against that matter; the
-- charge is reported to Stripe as a Billing Meter event and invoiced monthly. Cases
-- opened on a free trial, a comped account or in pilot mode are recorded but never
-- reported, so the ledger below is also the "what did we give away" record.

-- One row per (tenant, matter) ever charged — the uniqueness IS the once-only rule.
create table if not exists matter_charge (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id),
  matter_id uuid not null references matter(id),
  -- What first triggered the charge (a UsageFeature, e.g. DRAFT_REPLY).
  trigger_feature text not null,
  -- Pennies charged at the time (0 when not billed). Historical record: the advertised
  -- price can move without rewriting old rows.
  amount_pennies integer not null default 0,
  -- Whether the charge was reported to Stripe. false + reason for trial/comp/pilot,
  -- or for a report that failed (see stripe_error) and needs a retry.
  billed boolean not null default false,
  unbilled_reason text,            -- TRIAL | COMP | PILOT | NO_SUBSCRIPTION | ERROR
  stripe_customer_id text,
  stripe_meter_event_id text,      -- identifier we sent (idempotency key) — Stripe echoes it
  stripe_error text,
  charged_at timestamptz not null default now(),
  billed_at timestamptz,
  unique (tenant_id, matter_id)
);
create index if not exists matter_charge_tenant_month_idx on matter_charge (tenant_id, charged_at desc);

-- Collapse the old tier keys. Anything that was on a plan is now on the one plan.
update billing_account set plan = 'usage' where plan in ('plus', 'pro', 'enterprise', 'standard', 'team');
update billing_account set comp_plan = 'usage' where comp_plan is not null and comp_plan <> 'usage';

-- Analytics: there is no MRR under per-case billing — revenue is the meter. Keep the
-- join target so v_revenue* keep resolving; they now read 0 for recurring and the
-- case ledger (v_case_revenue) is the number that matters.
insert into plan_price (plan, mrr_pennies) values ('usage', 0)
on conflict (plan) do update set mrr_pennies = excluded.mrr_pennies;

-- Cases charged per tenant per calendar month, billed vs given away.
create or replace view v_case_revenue as
select
  tenant_id,
  date_trunc('month', charged_at) as month,
  count(*)                                   as cases,
  count(*) filter (where billed)             as billed_cases,
  coalesce(sum(amount_pennies) filter (where billed), 0) as billed_pennies,
  count(*) filter (where not billed)         as free_cases
from matter_charge
group by tenant_id, date_trunc('month', charged_at);
