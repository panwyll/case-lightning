-- EPA (docs/epa.md): the attention timeline. One row per stretch of a person's attention on one item
-- in CONVEYi (Focus) or in Outlook with the CONVEYi pane open (Reading). Outlook compose and estimates
-- come from workload_email and are not stored here. No content: which item, what kind of work, when.

create table if not exists activity_span (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id),
  user_id     uuid not null references app_user(id),
  started_at  timestamptz not null,
  ended_at    timestamptz not null,
  source      text not null check (source in ('focus', 'reading')),
  -- What was being worked on: a task id, an email id, a draft. The unit of a switch.
  item        text not null,
  matter_id   uuid null,
  -- The kind of work (epa/taxonomy.ts) and, for Checking Drafts, what the draft was and its CONVEYi action.
  kind        text not null,
  draft_of    text null,
  action      text null,
  created_at  timestamptz not null default now(),
  check (ended_at > started_at and ended_at - started_at <= interval '4 hours')
);
create index if not exists activity_span_user_idx on activity_span (user_id, started_at);
create index if not exists activity_span_tenant_idx on activity_span (tenant_id, started_at);

alter table activity_span enable row level security;
drop policy if exists activity_span_all on activity_span;
create policy activity_span_all on activity_span for all to public using (true) with check (true);

comment on table activity_span is 'EPA attention evidence: one person on one item for a stretch of time. No content is stored.';
