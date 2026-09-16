-- Addendum 3 §1 — enforcement, not instruction.
--
-- Every "requires human sign-off" rule now exists as a database fact:
--   * matter_event_human_gate(): an INSERT of a payment-triggering event
--     (funds_requested, payment_authorised) or an outbound-AI-content event
--     (report_on_title_sent) is rejected unless payload.approvedBy is a real human
--     app_user in the same tenant — and, for report_on_title_sent, the approval event
--     it cites exists on the same matter, is a report_on_title_approved, and was written
--     by that same human. A code path that "forgets" the check cannot write the row.
--   * conveyi_automation: a NOLOGIN role that automation contexts (cron, webhooks,
--     ingestion, the engine's own post-commit effects, any AI-driven process) switch to
--     with SET LOCAL ROLE. A RESTRICTIVE policy denies it INSERTs of those event types
--     outright — even a correct-looking approvedBy is refused from automation. Only the
--     human-request pathway (the app role itself) can write them.
--
-- Addendum 3 §2 — shadow mode.
--   * matter.shadow_mode: the engine logs everything as normal but nothing is surfaced,
--     sent, ordered or mirrored onto the real stage (lib/server/engine).
--   * engine_subflow_status: per-tenant, per-sub-flow shadow | assist | autonomous.
--   * engine_shadow_review: the reviewer's verdict on each shadow conclusion — the
--     evidence used to promote a sub-flow.

-- ── §1 trigger: the human gate ──
create or replace function matter_event_human_gate() returns trigger language plpgsql as $$
declare approver uuid; approval_event uuid; ok boolean;
begin
  if new.type not in ('funds_requested','payment_authorised','report_on_title_sent') then
    return new;
  end if;
  begin
    approver := (new.payload->>'approvedBy')::uuid;
  exception when others then
    approver := null;
  end;
  if approver is null then
    raise exception 'event % requires payload.approvedBy — a human user id (addendum 3 §1)', new.type using errcode = '23514';
  end if;
  select exists (select 1 from app_user u where u.id = approver and u.tenant_id = new.tenant_id) into ok;
  if not ok then
    raise exception 'event % approvedBy % is not a human user of this firm', new.type, approver using errcode = '23514';
  end if;
  if new.type = 'report_on_title_sent' then
    begin
      approval_event := (new.payload->>'approvedEventId')::uuid;
    exception when others then
      approval_event := null;
    end;
    if approval_event is null or not exists (
      select 1 from matter_event a
       where a.id = approval_event and a.matter_id = new.matter_id and a.tenant_id = new.tenant_id
         and a.type = 'report_on_title_approved' and a.actor = approver::text
    ) then
      raise exception 'report_on_title_sent must cite a report_on_title_approved event on this matter written by approvedBy %', approver using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists matter_event_human_gate_trg on matter_event;
create trigger matter_event_human_gate_trg before insert on matter_event
  for each row execute function matter_event_human_gate();

-- ── §1 role: automation may never write human-gated events ──
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'conveyi_automation') then
    create role conveyi_automation nologin nobypassrls nosuperuser;
  end if;
end $$;
grant usage on schema public to conveyi_automation;
grant select, insert, update, delete on all tables in schema public to conveyi_automation;
grant usage, select on all sequences in schema public to conveyi_automation;
grant execute on all functions in schema public to conveyi_automation;
-- Let the app role step down into it (SET LOCAL ROLE) for automation contexts.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'conveyi_app') then
    execute 'grant conveyi_automation to conveyi_app';
  end if;
  if exists (select 1 from pg_roles where rolname = 'app_rls') then
    execute 'grant conveyi_automation to app_rls';
  end if;
end $$;
-- NOTE: the policy is written against current_user rather than `TO conveyi_automation`.
-- A policy targeted at a role also applies to every role that INHERITS membership of it
-- (has_privs_of_role), so `TO conveyi_automation` would lock the app role itself out the
-- moment it is granted the automation role. current_user only becomes conveyi_automation
-- after SET LOCAL ROLE — exactly the automation contexts, and nothing else.
drop policy if exists automation_no_human_gated_events on matter_event;
create policy automation_no_human_gated_events on matter_event as restrictive for insert to public
  with check (current_user <> 'conveyi_automation' or type not in ('funds_requested','payment_authorised','report_on_title_sent'));
-- matter_event needs RLS on for the restrictive policy to bite (the wall policy already enabled it; be explicit).
alter table matter_event enable row level security;
alter table matter_event force row level security;

-- ── §2 shadow mode ──
alter table matter add column if not exists shadow_mode boolean not null default false;
comment on column matter.shadow_mode is 'Engine observes only: events are logged, nothing surfaces, sends, orders or moves the real stage.';

create table if not exists engine_subflow_status (
  tenant_id  uuid not null references tenant(id) on delete cascade,
  sub_flow   text not null,            -- id_check | search | enquiry | mortgage | title | report_on_title | chase
  status     text not null default 'assist' check (status in ('shadow','assist','autonomous')),
  updated_by uuid references app_user(id),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, sub_flow)
);

create table if not exists engine_shadow_review (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id),
  matter_id   uuid not null references matter(id) on delete cascade,
  event_id    uuid not null references matter_event(id),
  sub_flow    text not null,
  agrees      boolean not null,          -- did the handler's actual handling agree with the engine's conclusion?
  human_outcome text,                    -- what the human actually did / recorded
  note        text,
  reviewer    uuid not null references app_user(id),
  created_at  timestamptz not null default now(),
  unique (event_id, reviewer)
);
create index if not exists engine_shadow_review_matter_idx on engine_shadow_review (tenant_id, matter_id);
alter table engine_shadow_review enable row level security;
alter table engine_shadow_review force row level security;
drop policy if exists engine_wall on engine_shadow_review;
create policy engine_wall on engine_shadow_review for all using (not engine_walled(matter_id)) with check (not engine_walled(matter_id));
grant select, insert, update, delete on engine_subflow_status, engine_shadow_review to conveyi_automation;
