-- Usage analytics: a per-call metering fact table plus the BI view layer.
--
-- Goal: understand user journeys, what features get used, how much each user
-- consumes, and profit per user / per tenant / globally. The app writes one
-- `usage_event` row per metered AI/embeddings call (lib/server/usage.ts); the
-- views below roll that up and join it against subscriptions for economics.
--
-- Currency: usage_event.cost_usd is what the upstream provider charged us (USD).
-- Revenue is in GBP pennies. The economics views convert USD→GBP via the tunable
-- `analytics_param('gbp_per_usd')` row so a single FX assumption lives in one place.

-- ── Reference / config tables ────────────────────────────────────────────────

-- Tunable scalars for the reporting layer (FX rate, etc.). One row per key.
create table if not exists analytics_param (
  key text primary key,
  value numeric not null,
  note text
);
insert into analytics_param (key, value, note) values
  ('gbp_per_usd', 0.79, 'USD→GBP conversion used by the economics views; update as FX moves')
on conflict (key) do nothing;

-- Published model rates (USD per 1M tokens). The app computes cost from code
-- (lib/server/pricing.ts) and stores the resolved cost on each event; this table
-- mirrors those rates so BI can show/recompute them. Keep in sync with pricing.ts.
create table if not exists model_price (
  provider text not null,
  model text not null,
  input_per_mtok_usd numeric not null,
  output_per_mtok_usd numeric not null,
  cache_read_per_mtok_usd numeric,
  cache_write_per_mtok_usd numeric,
  effective_from date not null default current_date,
  primary key (provider, model)
);
insert into model_price (provider, model, input_per_mtok_usd, output_per_mtok_usd, cache_read_per_mtok_usd, cache_write_per_mtok_usd) values
  ('anthropic', 'claude-opus-4-8',   5, 25, 0.5, 6.25),
  ('anthropic', 'claude-sonnet-4-6', 3, 15, 0.3, 3.75),
  ('anthropic', 'claude-haiku-4-5',  1,  5, 0.1, 1.25),
  ('groq', 'llama-3.3-70b-versatile', 0.59, 0.79, null, null),
  ('groq', 'llama-3.1-8b-instant',    0.05, 0.08, null, null),
  ('voyage', 'voyage-3-large', 0.18, 0, null, null),
  ('openai', 'text-embedding-3-large', 0.13, 0, null, null)
on conflict (provider, model) do nothing;

-- Subscription plan → monthly recurring revenue (GBP pennies). Matches the
-- pricing in the referral system (standard £200, team ~£500).
create table if not exists plan_price (
  plan text primary key,
  mrr_pennies bigint not null,
  currency text not null default 'gbp'
);
insert into plan_price (plan, mrr_pennies) values
  ('standard', 20000),
  ('team', 50000)
on conflict (plan) do nothing;

-- ── Fact table ───────────────────────────────────────────────────────────────

create table if not exists usage_event (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id),
  actor_user_id uuid references app_user(id),
  matter_id uuid,
  event_type text not null,                 -- feature: THREAD_SUMMARISE, DRAFT_REPLY, EMBED, ...
  kind text not null,                       -- 'AI' | 'EMBED'
  provider text,                            -- anthropic | groq | voyage | openai
  model text,
  tier text,                                -- draft | fast | classify (AI only)
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  cache_read_tokens bigint not null default 0,
  cache_write_tokens bigint not null default 0,
  total_tokens bigint generated always as (input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) stored,
  cost_usd numeric(16,8) not null default 0,  -- our cost; 0 for BYOK calls
  priced boolean not null default true,       -- false when model wasn't in the rate table
  byok boolean not null default false,        -- user supplied their own AI key
  status text not null default 'SUCCESS',     -- SUCCESS | FAILED
  latency_ms integer,
  session_id text,                            -- optional client correlation id
  request_id text,
  meta jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists usage_event_tenant_time_idx on usage_event (tenant_id, created_at desc);
create index if not exists usage_event_user_time_idx on usage_event (actor_user_id, created_at desc);
create index if not exists usage_event_feature_time_idx on usage_event (event_type, created_at desc);
create index if not exists usage_event_time_idx on usage_event (created_at desc);
create index if not exists usage_event_matter_idx on usage_event (matter_id);

-- ── Materialized daily rollup ────────────────────────────────────────────────
-- Pre-aggregates the fact table for fast dashboards. Refreshed by
-- /api/v1/admin/analytics/refresh (wire to a daily cron when volume warrants);
-- the plain views below are always live and don't depend on it.

create materialized view if not exists mv_usage_daily as
select
  date_trunc('day', created_at)::date as day,
  tenant_id,
  actor_user_id,
  event_type,
  kind,
  provider,
  model,
  count(*) as calls,
  sum(case when status = 'FAILED' then 1 else 0 end) as failed_calls,
  sum(input_tokens) as input_tokens,
  sum(output_tokens) as output_tokens,
  sum(cache_read_tokens) as cache_read_tokens,
  sum(cache_write_tokens) as cache_write_tokens,
  sum(total_tokens) as total_tokens,
  sum(cost_usd) as cost_usd,
  sum(case when byok then 1 else 0 end) as byok_calls,
  round(avg(latency_ms)) as avg_latency_ms
from usage_event
group by 1,2,3,4,5,6,7;

create index if not exists mv_usage_daily_idx on mv_usage_daily (day, tenant_id, actor_user_id);

-- ── Usage views (live, off the fact table) ──────────────────────────────────

create or replace view v_usage_daily as select * from mv_usage_daily;

create or replace view v_usage_by_user as
select
  u.tenant_id,
  u.actor_user_id,
  au.email,
  au.display_name,
  count(*) as calls,
  sum(u.total_tokens) as total_tokens,
  sum(u.cost_usd) as cost_usd,
  max(u.created_at) as last_active_at,
  min(u.created_at) as first_active_at
from usage_event u
left join app_user au on au.id = u.actor_user_id
group by u.tenant_id, u.actor_user_id, au.email, au.display_name;

create or replace view v_usage_by_tenant as
select
  u.tenant_id,
  t.name as tenant_name,
  count(*) as calls,
  count(distinct u.actor_user_id) as active_users,
  sum(u.total_tokens) as total_tokens,
  sum(u.cost_usd) as cost_usd,
  max(u.created_at) as last_active_at
from usage_event u
left join tenant t on t.id = u.tenant_id
group by u.tenant_id, t.name;

create or replace view v_usage_by_feature as
select
  event_type as feature,
  kind,
  count(*) as calls,
  count(distinct actor_user_id) as users,
  count(distinct tenant_id) as tenants,
  sum(total_tokens) as total_tokens,
  sum(cost_usd) as cost_usd,
  round(avg(latency_ms)) as avg_latency_ms,
  sum(case when status = 'FAILED' then 1 else 0 end) as failed_calls
from usage_event
group by event_type, kind
order by calls desc;

-- ── Revenue & economics ──────────────────────────────────────────────────────

create or replace view v_revenue_by_tenant as
select
  ba.tenant_id,
  ba.plan,
  ba.status,
  coalesce(pp.mrr_pennies, 0) as mrr_pennies,
  case when ba.status = 'active' then coalesce(pp.mrr_pennies, 0) else 0 end as active_mrr_pennies,
  ba.credit_balance_pennies
from billing_account ba
left join plan_price pp on pp.plan = ba.plan
where ba.tenant_id is not null;

-- Profit per tenant over the trailing 30 days: active MRR minus AI cost (GBP).
create or replace view v_tenant_economics as
with fx as (select value as gbp_per_usd from analytics_param where key = 'gbp_per_usd'),
cost30 as (
  select tenant_id, sum(cost_usd) as cost_usd
  from usage_event
  where created_at >= now() - interval '30 days'
  group by tenant_id
),
rev as (
  select tenant_id, sum(active_mrr_pennies) as mrr_pennies
  from v_revenue_by_tenant
  group by tenant_id
)
select
  t.id as tenant_id,
  t.name as tenant_name,
  coalesce(rev.mrr_pennies, 0) as mrr_pennies_gbp,
  coalesce(c.cost_usd, 0) as ai_cost_usd_30d,
  round(coalesce(c.cost_usd, 0) * (select gbp_per_usd from fx) * 100) as ai_cost_pennies_gbp_30d,
  coalesce(rev.mrr_pennies, 0)
    - round(coalesce(c.cost_usd, 0) * (select gbp_per_usd from fx) * 100) as gross_profit_pennies_30d
from tenant t
left join rev on rev.tenant_id = t.id
left join cost30 c on c.tenant_id = t.id;

-- Profit per user: the tenant's MRR shared across its active users, minus that
-- user's own AI cost (30d). Allocation is MRR / active-user count — a simplifying
-- assumption documented here so the number isn't read as exact attribution.
create or replace view v_user_economics as
with fx as (select value as gbp_per_usd from analytics_param where key = 'gbp_per_usd'),
cost30 as (
  select tenant_id, actor_user_id, sum(cost_usd) as cost_usd
  from usage_event
  where created_at >= now() - interval '30 days' and actor_user_id is not null
  group by tenant_id, actor_user_id
),
active as (
  select tenant_id, count(distinct actor_user_id) as active_users
  from usage_event
  where created_at >= now() - interval '30 days' and actor_user_id is not null
  group by tenant_id
),
rev as (
  select tenant_id, sum(active_mrr_pennies) as mrr_pennies
  from v_revenue_by_tenant
  group by tenant_id
)
select
  c.tenant_id,
  c.actor_user_id,
  au.email,
  au.display_name,
  c.cost_usd as ai_cost_usd_30d,
  round(c.cost_usd * (select gbp_per_usd from fx) * 100) as ai_cost_pennies_gbp_30d,
  round(coalesce(rev.mrr_pennies, 0) / nullif(active.active_users, 0)) as allocated_mrr_pennies_gbp,
  round(coalesce(rev.mrr_pennies, 0) / nullif(active.active_users, 0))
    - round(c.cost_usd * (select gbp_per_usd from fx) * 100) as allocated_profit_pennies_30d
from cost30 c
left join app_user au on au.id = c.actor_user_id
left join active on active.tenant_id = c.tenant_id
left join rev on rev.tenant_id = c.tenant_id;

-- Global one-row summary: total revenue, total cost, total profit.
create or replace view v_global_economics as
with fx as (select value as gbp_per_usd from analytics_param where key = 'gbp_per_usd')
select
  (select sum(active_mrr_pennies) from v_revenue_by_tenant) as total_mrr_pennies_gbp,
  (select coalesce(sum(cost_usd), 0) from usage_event where created_at >= now() - interval '30 days') as ai_cost_usd_30d,
  round((select coalesce(sum(cost_usd), 0) from usage_event where created_at >= now() - interval '30 days')
    * (select gbp_per_usd from fx) * 100) as ai_cost_pennies_gbp_30d,
  coalesce((select sum(active_mrr_pennies) from v_revenue_by_tenant), 0)
    - round((select coalesce(sum(cost_usd), 0) from usage_event where created_at >= now() - interval '30 days')
        * (select gbp_per_usd from fx) * 100) as gross_profit_pennies_30d,
  (select coalesce(sum(credit_balance_pennies), 0) from billing_account) as outstanding_credit_pennies_gbp;

-- ── Journeys & funnel (from the audit log — the per-action timeline) ──────────

-- Combined raw activity stream for ad-hoc exploration. Tags each row's source so
-- the analyst can filter (audit = actions taken, usage = metered/billable calls).
create or replace view v_activity as
select tenant_id, actor_user_id, matter_id, action_type as event_type, 'AUDIT' as source,
       action_status as status, created_at
from audit_log
union all
select tenant_id, actor_user_id, matter_id, event_type, 'USAGE' as source,
       status, created_at
from usage_event;

-- Gap-based sessions: a new session starts after >30 min of inactivity. Built
-- from the audit log (every product action is audited) so it needs no client
-- session id. action_sequence is the ordered list of actions in the session.
create or replace view v_user_sessions as
with ordered as (
  select
    tenant_id, actor_user_id, action_type, matter_id, created_at,
    lag(created_at) over (partition by tenant_id, actor_user_id order by created_at) as prev_at
  from audit_log
  where actor_user_id is not null
),
marked as (
  select *,
    case when prev_at is null or created_at - prev_at > interval '30 minutes' then 1 else 0 end as is_new
  from ordered
),
sessioned as (
  select *,
    sum(is_new) over (partition by tenant_id, actor_user_id order by created_at
                      rows between unbounded preceding and current row) as session_seq
  from marked
)
select
  tenant_id,
  actor_user_id,
  session_seq,
  min(created_at) as started_at,
  max(created_at) as ended_at,
  max(created_at) - min(created_at) as duration,
  count(*) as action_count,
  count(distinct matter_id) as matters_touched,
  array_agg(action_type order by created_at) as action_sequence
from sessioned
group by tenant_id, actor_user_id, session_seq;

-- Feature adoption funnel: how many distinct users have ever used each action.
create or replace view v_feature_funnel as
select
  action_type as feature,
  count(distinct actor_user_id) as users,
  count(distinct tenant_id) as tenants,
  count(*) as events,
  min(created_at) as first_seen,
  max(created_at) as last_seen
from audit_log
where actor_user_id is not null
group by action_type
order by users desc, events desc;
