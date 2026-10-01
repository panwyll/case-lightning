-- How clients rate us (docs/spec/ui.md "Client portal", analytics).
--
-- Asked on the client portal at two moments, once each: after exchange, a one-question
-- satisfaction score (CSAT, 1-5), and after completion, how likely they are to recommend us
-- (NPS, 0-10), with an optional comment. The handler at the time is kept, so the analytics can
-- show it per person.
create table if not exists client_feedback (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id),
  matter_id   uuid not null references matter(id) on delete cascade,
  milestone   text not null check (milestone in ('exchanged', 'completed')),
  kind        text not null check (kind in ('csat', 'nps')),
  score       int not null check (score between 0 and 10),
  comment     text null,
  handler_id  uuid null references app_user(id),
  created_at  timestamptz not null default now(),
  unique (matter_id, milestone)
);
create index if not exists client_feedback_tenant_idx on client_feedback (tenant_id, created_at desc);

alter table client_feedback enable row level security;
-- Written by the portal's public route (as the system); read by the firm's analytics.
drop policy if exists client_feedback_all on client_feedback;
create policy client_feedback_all on client_feedback for all to public using (true) with check (true);
grant select, insert on client_feedback to conveyi_automation;

comment on table client_feedback is 'Client ratings from the portal: CSAT (1-5) after exchange, NPS (0-10) after completion; one per milestone per case.';
