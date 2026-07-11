-- Proactive notification loop. When something happens on a matter (stage moved, a
-- document landed, an inbound email was triaged), we record a timeline event AND queue
-- a notification for the matter's fee-earner. A worker batches each person's pending
-- notifications into ONE "here's what came up" briefing email — the "I'm on top of it"
-- voice — rather than firing one email per ping.
create table if not exists notification (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id) on delete cascade,
  user_id     uuid not null references app_user(id) on delete cascade,  -- recipient (fee-earner)
  matter_id   uuid references matter(id) on delete set null,
  matter_ref  text,
  kind        text not null,        -- STATUS_CHANGED | DOC_RECEIVED | EMAIL_TRIAGED
  headline    text not null,        -- "what came up"
  did         text,                 -- "what I've already done about it"
  action      text,                 -- "the one thing you need to do"
  dedup_key   text,                 -- collapse a burst on the same matter+kind while still pending
  status      text not null default 'PENDING',  -- PENDING | SENT | DISMISSED
  created_at  timestamptz not null default now(),
  sent_at     timestamptz
);

create index if not exists notification_due_idx on notification (status, created_at);
create index if not exists notification_user_idx on notification (user_id, status, created_at);
-- One pending notification per matter+kind+dedup_key, so repeated pings collapse.
create unique index if not exists notification_dedup_idx
  on notification (tenant_id, kind, dedup_key)
  where dedup_key is not null and status = 'PENDING';

-- Per-person off switch so we never hammer someone who doesn't want the briefings.
alter table app_user add column if not exists notify_enabled boolean not null default true;
