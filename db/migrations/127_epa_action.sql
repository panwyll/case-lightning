-- EPA, live (docs/epa.md §2): the timed actions the live Time page measures, recorded as they happen — each email a
-- person sends (classified as it is sent, off the Sent Items subscription), and what the firm files or completes in
-- InTouch (read daily by the InTouch sync, and from its Task State Change webhook). The same evidence the onboarding
-- measurement reads from a scan, so the live page and the measurement measure green the same way.

create table if not exists epa_action (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id),
  user_id       uuid not null references app_user(id),
  -- sent: an email the person sent. intouch_file: a document or note the firm filed. intouch_task: an InTouch task completed.
  source        text not null check (source in ('sent', 'intouch_file', 'intouch_task')),
  -- The Graph message id, or InTouch's case and item: one action is recorded once.
  ref           text not null,
  at            timestamptz not null,
  -- Sent email: when Outlook's draft was started, its category (workload/taxonomy.ts) and who it went to.
  drafted_at    timestamptz null,
  category      text null,
  roles         text[] not null default '{}',
  -- InTouch: the kind of work (epa/taxonomy.ts), the document or task name, and the case.
  kind          text null,
  name          text null,
  case_id       text null,
  classified_by text null,
  created_at    timestamptz not null default now(),
  unique (user_id, source, ref)
);
create index if not exists epa_action_user_idx on epa_action (user_id, at);
create index if not exists epa_action_tenant_idx on epa_action (tenant_id, at);

alter table epa_action enable row level security;
drop policy if exists epa_action_all on epa_action;
create policy epa_action_all on epa_action for all to public using (true) with check (true);

-- An InTouch task's name, read once as a kind of work: every later completion of a task with that name is that kind.
create table if not exists epa_task_kind (
  tenant_id   uuid not null references tenant(id),
  name        text not null,
  kind        text not null,
  created_at  timestamptz not null default now(),
  primary key (tenant_id, name)
);
alter table epa_task_kind enable row level security;
drop policy if exists epa_task_kind_all on epa_task_kind;
create policy epa_task_kind_all on epa_task_kind for all to public using (true) with check (true);

-- How far the daily InTouch read has got.
alter table intouch_connection add column if not exists activity_since timestamptz null;

comment on table epa_action is 'Timed actions for the live Time page: sent email classified as sent, InTouch filings and task completions (docs/epa.md §2).';
