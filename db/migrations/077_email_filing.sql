-- Filing email to cases (docs/email-filing.md).
--
-- The web app's email view is not an inbox. It is a queue of email that is not yet on a
-- case, and its only job is to empty. That needs one thing the schema did not have: a
-- record that a human looked at a thread and said "this does not belong to a case" — so
-- it stops coming back, for everyone, without anyone deleting or archiving mail that is
-- not ours to touch.
create table if not exists email_not_filed (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references tenant(id) on delete cascade,
  -- The conversation, not the message: dismissing one reply should retire the thread.
  graph_conversation_id text not null,
  subject               text,
  dismissed_by          uuid references app_user(id),
  reason                text,
  created_at            timestamptz not null default now()
);
create unique index if not exists email_not_filed_key on email_not_filed (tenant_id, graph_conversation_id);
create index if not exists email_not_filed_recent on email_not_filed (tenant_id, created_at desc);

alter table email_not_filed enable row level security;
drop policy if exists email_not_filed_tenant on email_not_filed;
create policy email_not_filed_tenant on email_not_filed for all to public using (true) with check (true);
grant select, insert, delete on email_not_filed to conveyi_automation;

comment on table email_not_filed is 'Threads a person has said are not case email, so the filing queue stops offering them. Reversible: delete the row and the thread returns.';
