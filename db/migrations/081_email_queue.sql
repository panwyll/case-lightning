-- The filing queue as a table, not a Graph read.
--
-- Until now "email to file" was the newest 25 inbox messages minus what was filed or set
-- aside — read live from Microsoft Graph on every page load and every sidebar badge. A
-- conveyancer gets 200–300 emails a day, so that window covered about an hour and the
-- queue silently lost everything older. Now every inbound message the triage sees that it
-- cannot file definitively is written here once, with its sender check, its best case
-- matches and whether it is bulk mail; the page and the badge read this table. Filing a
-- thread or setting it aside resolves its rows. A sweep of the mailbox fills the backlog
-- for a mailbox that predates the subscription, and a one-page sweep on each load catches
-- anything a lapsed subscription missed.
create table if not exists email_queue (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references tenant(id) on delete cascade,
  mailbox_user_id       uuid not null references app_user(id) on delete cascade,
  graph_message_id      text not null,
  graph_conversation_id text,
  subject               text,
  from_name             text,
  from_address          text,
  received_at           timestamptz,
  body_preview          text,
  forwarded_from        text,
  has_attachments       boolean not null default false,
  web_link              text,
  -- Why this is probably not case mail (mailing-list headers, or the AI triage read it as
  -- unrelated), null when it looks like case mail. Set once at enqueue.
  not_case_mail         text,
  sender                jsonb not null default '{}',   -- {verdict, warnings[]} from mail/sender-check
  candidates            jsonb not null default '[]',   -- top matches [{matterId, matterRef, propertyAddress, band, score, signals[]}]
  created_at            timestamptz not null default now(),
  -- Resolved rows stay for history; the queue is where resolved_at is null.
  resolved_at           timestamptz,
  resolution            text,                          -- FILED | SET_ASIDE
  resolved_matter_id    uuid references matter(id) on delete set null,
  unique (tenant_id, graph_message_id)
);
create index if not exists email_queue_open_idx on email_queue (tenant_id, mailbox_user_id, received_at desc) where resolved_at is null;
create index if not exists email_queue_conversation_idx on email_queue (tenant_id, graph_conversation_id);

alter table email_queue enable row level security;
drop policy if exists email_queue_tenant on email_queue;
create policy email_queue_tenant on email_queue for all to public using (true) with check (true);
grant select, insert, update on email_queue to conveyi_automation;

-- When each mailbox was last swept in full, so the backlog sweep runs once.
create table if not exists email_queue_sweep (
  tenant_id      uuid not null references tenant(id) on delete cascade,
  user_id        uuid not null references app_user(id) on delete cascade,
  full_swept_at  timestamptz,
  recent_swept_at timestamptz,
  primary key (tenant_id, user_id)
);
grant select, insert, update on email_queue_sweep to conveyi_automation;

comment on table email_queue is 'Inbound email not yet on a case, one row per message, written by triage and the mailbox sweep. The Email page and the sidebar badge read this; Graph is no longer read to list it.';
