-- Secure links for files sent to a client (docs/spec/triggers.md "Files go as a secure link").
--
-- A document the client is sent (a report on title, a copy they asked for, a completion statement)
-- goes as a link, not an attachment. The link's token is stored hashed; opening it asks for a
-- six-digit code emailed to the client's address on the case (stored hashed, short-lived, limited
-- attempts). Every open and download is counted, so the case knows the client has it.
create table if not exists file_share (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenant(id),
  matter_id        uuid not null references matter(id) on delete cascade,
  token_hash       text not null unique,
  document_ids     uuid[] not null,
  file_names       text[] not null,
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null default now() + interval '60 days',
  code_hash        text null,
  code_expires_at  timestamptz null,
  code_attempts    int not null default 0,
  codes_sent       int not null default 0,
  code_sent_at     timestamptz null,
  first_opened_at  timestamptz null,
  last_opened_at   timestamptz null,
  downloads        int not null default 0
);
create index if not exists file_share_matter_idx on file_share (tenant_id, matter_id, created_at desc);

alter table file_share enable row level security;
-- The public link route runs as the system (no user bound).
drop policy if exists file_share_tenant on file_share;
create policy file_share_tenant on file_share for all to public using (true) with check (true);
grant select, insert, update on file_share to conveyi_automation;

comment on table file_share is 'One row per secure link to files sent to a client; token and code stored hashed; opens and downloads counted.';
