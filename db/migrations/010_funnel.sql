-- Acquisition / retention funnel + visit tracking.
--
-- Adds the two data sources the funnel needs that the product didn't capture:
--   * pageview_event  — first-party top-of-funnel visits (a beacon writes these)
--   * subscription_event — append-only subscription status history (the Stripe
--     webhook writes these) so churn / retention / MRR movement are computable.
--
-- The funnel views below stitch these together with leads (waitlist), app_user,
-- matter, billing_account and audit_log to show where people drop out from first
-- visit through to a retained paying customer. CPA is intentionally deferred — UTM
-- channel is captured on every pageview so it can be added without a schema change.
--
-- Depends on the `leads` table (the waitlist target) and 009_analytics.sql.

-- ── Top of funnel: first-party pageviews ─────────────────────────────────────
create table if not exists pageview_event (
  id uuid primary key default gen_random_uuid(),
  visitor_id text not null,                 -- anonymous id from the cl_vid cookie
  path text not null,
  referrer text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  user_agent text,
  created_at timestamptz not null default now()
);
create index if not exists pageview_visitor_idx on pageview_event (visitor_id);
create index if not exists pageview_time_idx on pageview_event (created_at desc);
create index if not exists pageview_source_idx on pageview_event (utm_source);

-- ── Subscription status history (append-only) ────────────────────────────────
create table if not exists subscription_event (
  id uuid primary key default gen_random_uuid(),
  billing_account_id uuid references billing_account(id),
  tenant_id uuid,
  stripe_customer_id text,
  event_type text not null,                 -- CHECKOUT | PAID | PAST_DUE | SUBSCRIPTION | CANCELED
  from_status text,
  to_status text,
  plan text,
  mrr_pennies bigint not null default 0,
  occurred_at timestamptz not null default now(),
  meta jsonb not null default '{}'
);
create index if not exists subscription_event_account_idx on subscription_event (billing_account_id, occurred_at);
create index if not exists subscription_event_type_idx on subscription_event (event_type, occurred_at desc);
create index if not exists subscription_event_status_idx on subscription_event (to_status, occurred_at desc);

-- ── The giant funnel: forward stages with conversion + drop-off ──────────────
-- Stages mix units (visitors → leads → accounts) as acquisition funnels do; each
-- row carries the count, its share of the top, the step conversion and the drop.
create or replace view v_funnel_global as
with stages(stage, ord, cnt) as (
  values
    ('Visitors',              1, (select count(distinct visitor_id) from pageview_event)),
    ('Viewed pricing/trial',  2, (select count(distinct visitor_id) from pageview_event
                                   where path ~* '(pricing|start-trial)')),
    ('Joined waitlist',       3, (select count(*) from leads)),
    ('Account created',       4, (select count(*) from billing_account)),
    ('Activated (did something)', 5, (select count(distinct tenant_id) from audit_log)),
    ('Created a matter',      6, (select count(distinct tenant_id) from matter)),
    ('Paid',                  7, (select count(distinct billing_account_id)
                                   from subscription_event where event_type = 'PAID')),
    ('Retained (active 30d+)',8, (select count(*) from billing_account
                                   where status = 'active' and created_at < now() - interval '30 days'))
)
select
  stage,
  ord as stage_order,
  cnt as count,
  round(100.0 * cnt / nullif(first_value(cnt) over (order by ord), 0), 1) as pct_of_top,
  round(100.0 * cnt / nullif(lag(cnt) over (order by ord), 0), 1) as conversion_from_prev_pct,
  greatest(coalesce(lag(cnt) over (order by ord), cnt) - cnt, 0) as dropoff_from_prev
from stages
order by ord;

-- Visits over time and by channel (top of funnel).
create or replace view v_visits_daily as
select
  date_trunc('day', created_at)::date as day,
  count(*) as pageviews,
  count(distinct visitor_id) as visitors
from pageview_event
group by 1 order by 1;

create or replace view v_visits_by_channel as
select
  coalesce(utm_source, '(direct)') as source,
  coalesce(utm_medium, '(none)') as medium,
  coalesce(utm_campaign, '(none)') as campaign,
  count(*) as pageviews,
  count(distinct visitor_id) as visitors
from pageview_event
group by 1,2,3 order by visitors desc;

-- ── Acquisition / churn / MRR movement (from subscription_event) ─────────────

-- New paying customers per month = the first PAID event per account.
create or replace view v_acquisition_monthly as
with first_paid as (
  select billing_account_id, min(occurred_at) as acquired_at,
         max(mrr_pennies) filter (where mrr_pennies > 0) as mrr_pennies
  from subscription_event
  where event_type = 'PAID'
  group by billing_account_id
)
select
  date_trunc('month', acquired_at)::date as month,
  count(*) as new_customers,
  coalesce(sum(mrr_pennies), 0) as new_mrr_pennies
from first_paid
group by 1 order by 1;

-- Churn per month = the first cancellation per account.
create or replace view v_churn_monthly as
with first_cancel as (
  select se.billing_account_id, min(se.occurred_at) as churned_at,
         (select sc.mrr_pennies from subscription_event sc
          where sc.billing_account_id = se.billing_account_id and sc.mrr_pennies > 0
          order by sc.occurred_at desc limit 1) as mrr_pennies
  from subscription_event se
  where se.to_status = 'canceled'
  group by se.billing_account_id
)
select
  date_trunc('month', churned_at)::date as month,
  count(*) as churned_customers,
  coalesce(sum(mrr_pennies), 0) as churned_mrr_pennies
from first_cancel
group by 1 order by 1;

-- Net MRR movement per month: new minus churned.
create or replace view v_mrr_movement_monthly as
select
  coalesce(a.month, c.month) as month,
  coalesce(a.new_customers, 0) as new_customers,
  coalesce(a.new_mrr_pennies, 0) as new_mrr_pennies,
  coalesce(c.churned_customers, 0) as churned_customers,
  coalesce(c.churned_mrr_pennies, 0) as churned_mrr_pennies,
  coalesce(a.new_mrr_pennies, 0) - coalesce(c.churned_mrr_pennies, 0) as net_mrr_pennies
from v_acquisition_monthly a
full outer join v_churn_monthly c on a.month = c.month
order by 1;

-- Headline retention snapshot: lifetime acquired / churned / current active.
create or replace view v_retention_summary as
select
  (select count(distinct billing_account_id) from subscription_event where event_type = 'PAID') as ever_paid,
  (select count(distinct billing_account_id) from subscription_event where to_status = 'canceled') as ever_churned,
  (select count(*) from billing_account where status = 'active') as active_now,
  (select count(*) from billing_account where status = 'trialing') as trialing_now,
  round(
    100.0 * (select count(distinct billing_account_id) from subscription_event where to_status = 'canceled')
    / nullif((select count(distinct billing_account_id) from subscription_event where event_type = 'PAID'), 0),
    1
  ) as lifetime_churn_rate_pct;
