-- The two records analytics cannot reconstruct later (docs/analytics.md).
--
-- firm_baseline: the firm's own figures from before CONVEYi, so "faster than before" has a
-- "before". Append-only; the latest row is current.
create table if not exists firm_baseline (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  weeks_purchase numeric(5,1),          -- instruction to completion, a typical purchase
  weeks_sale numeric(5,1),              -- instruction to completion, a typical sale
  cases_per_conveyancer numeric(6,1),   -- open cases one conveyancer carries
  hours_per_case numeric(6,1),          -- fee-earner hours on a typical case
  recorded_by uuid,
  recorded_at timestamptz not null default now()
);
create index if not exists firm_baseline_tenant_idx on firm_baseline (tenant_id, recorded_at desc);

-- task_record: when each task appeared on a list and when it left, and who closed it.
-- Tasks are computed from the case (work.ts matterWork), never stored, so without this the
-- time a task sat waiting is lost. Written when the case changes (store.ts) and when a
-- Tasks list is read (catches time-driven ones).
create table if not exists task_record (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  matter_id uuid not null,
  task_id text not null,        -- <ref type>:<ref id>, the same key task_dismissal.ref uses
  bucket text not null,         -- do | waiting | escalate
  kind text,
  chip text,
  title text,
  assigned_to uuid,
  opened_at timestamptz not null default now(),
  opened_seq int,
  closed_at timestamptz,
  closed_seq int,
  closed_by text,               -- the actor of the event that cleared it: a person's id, system, ai, external
  closed_how text               -- done | case_closed
);
create unique index if not exists task_record_open_idx on task_record (matter_id, task_id) where closed_at is null;
create index if not exists task_record_tenant_idx on task_record (tenant_id, opened_at);

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'conveyi_automation') then
    grant select, insert, update on task_record to conveyi_automation;
    grant select on firm_baseline to conveyi_automation;
  end if;
  if exists (select 1 from pg_roles where rolname = 'claude_readonly') then
    grant select on task_record, firm_baseline to claude_readonly;
  end if;
end $$;

-- How long our tasks wait before someone clears them, by kind of work.
create or replace view v_task_turnaround as
select r.tenant_id, r.bucket, coalesce(r.chip, r.kind, 'Other') as work,
       count(*) as opened,
       count(*) filter (where r.closed_how = 'done') as done,
       count(*) filter (where r.closed_how = 'done' and r.closed_by ~ '^[0-9a-f-]{36}$') as done_by_person,
       round((percentile_cont(0.5) within group (order by extract(epoch from r.closed_at - r.opened_at) / 3600) filter (where r.closed_how = 'done'))::numeric, 1) as median_hours_open
  from task_record r join matter m on m.id = r.matter_id
 where not coalesce(m.sandbox, false)
 group by 1, 2, 3;

-- Who does the work on a case, month by month: a person, the system, the AI or an outside party.
create or replace view v_work_by_actor_monthly as
select e.tenant_id, date_trunc('month', e.created_at) as month,
       case when e.actor ~ '^[0-9a-f-]{36}$' then 'person' when e.actor in ('system', 'ai', 'external') then e.actor else 'other' end as actor_kind,
       count(*) as events
  from matter_event e join matter m on m.id = e.matter_id
 where not coalesce(m.sandbox, false)
 group by 1, 2, 3;

-- Instruction to exchange and completion, per case (weeks), against the firm's own baseline.
create or replace view v_case_duration as
select s.tenant_id, s.matter_id, m.track,
       min(e.created_at) filter (where e.type = 'matter_created') as opened_at,
       min(e.created_at) filter (where e.type = 'contracts_exchanged') as exchanged_at,
       min(e.created_at) filter (where e.type = 'completion_confirmed') as completed_at,
       round((extract(epoch from min(e.created_at) filter (where e.type = 'completion_confirmed') - min(e.created_at) filter (where e.type = 'matter_created')) / 604800)::numeric, 1) as weeks_to_complete,
       (select case when m.track = 'SALE' then b.weeks_sale else b.weeks_purchase end from firm_baseline b where b.tenant_id = s.tenant_id order by b.recorded_at desc limit 1) as baseline_weeks
  from matter_engine_state s join matter m on m.id = s.matter_id join matter_event e on e.matter_id = s.matter_id
 where not coalesce(m.sandbox, false)
 group by s.tenant_id, s.matter_id, m.track;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'claude_readonly') then
    grant select on v_task_turnaround, v_work_by_actor_monthly, v_case_duration to claude_readonly;
  end if;
end $$;
