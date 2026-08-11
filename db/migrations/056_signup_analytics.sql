-- Signup analytics.
--
-- v_acquisition_monthly only counts PAID acquisition (subscription_event 'PAID'), so
-- before the first sale the dashboard reads as empty even when firms are signing up and
-- using the product. These two views answer the pre-revenue questions: who has connected,
-- when, and did they do anything afterwards.

-- New tenants and users per day, with how many of that day's tenants went on to do
-- something. Left joins so a day with signups but no activity still shows.
create or replace view v_signups_daily as
with days as (
  select generate_series(
           least(coalesce((select min(created_at)::date from tenant), current_date),
                 current_date - interval '30 days')::date,
           current_date,
           interval '1 day')::date as day
),
t as (
  select created_at::date as day, count(*) as new_tenants
  from tenant group by 1
),
u as (
  select created_at::date as day, count(*) as new_users
  from app_user group by 1
),
-- "Activated" = the tenant wrote an audit row at some point, attributed to its signup day.
a as (
  select tn.created_at::date as day, count(distinct tn.id) as activated_tenants
  from tenant tn
  where exists (select 1 from audit_log al where al.tenant_id = tn.id)
  group by 1
)
select
  d.day,
  coalesce(t.new_tenants, 0)       as new_tenants,
  coalesce(u.new_users, 0)         as new_users,
  coalesce(a.activated_tenants, 0) as activated_tenants
from days d
left join t on t.day = d.day
left join u on u.day = d.day
left join a on a.day = d.day
order by d.day;

-- One row per tenant: the "who actually turned up" list. Deliberately includes tenants
-- with no billing_account and no activity — those are the ones worth knowing about,
-- because they installed, connected, and then stopped.
create or replace view v_tenant_signups as
select
  tn.id                                   as tenant_id,
  tn.name                                 as firm_name,
  -- A tenant still called "Tenant-<uuid>" never completed step 1 of onboarding.
  (tn.name ~* '^Tenant[-\s]')             as unnamed,
  tn.created_at                           as signed_up_at,
  (select count(*) from app_user au where au.tenant_id = tn.id)        as users,
  (select count(*) from matter m where m.tenant_id = tn.id)            as matters,
  (select count(*) from audit_log al where al.tenant_id = tn.id)       as actions,
  (select max(al.created_at) from audit_log al where al.tenant_id = tn.id) as last_seen_at,
  ba.status                               as billing_status,
  ba.plan                                 as plan,
  ba.comp_plan                            as comp_plan
from tenant tn
left join billing_account ba on ba.tenant_id = tn.id
order by tn.created_at desc;
