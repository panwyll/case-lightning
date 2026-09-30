-- Open banking for source of funds (docs/proof-of-funds.md §9).
--
-- From the proof-of-funds form the client (or a donor) connects a bank through the provider. One row
-- per connection: which source on the form it is for, whose it is, the bank, the provider's reference,
-- and the documents made from the accounts shared (each an ordinary `document`, doc_type
-- OPEN_BANKING_ACCOUNT, source_type OPEN_BANKING, whose extracted_facts.statement is the account's
-- transactions as a statement). No bank credentials ever reach us; the consent is the provider's.
create table if not exists open_banking_connection (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenant(id),
  matter_id        uuid not null references matter(id) on delete cascade,
  request_id       uuid not null references proof_of_funds_request(id) on delete cascade,
  source_index     int not null,
  party            text not null check (party in ('client', 'donor')),
  provider         text not null,
  institution_id   text not null,
  institution_name text not null,
  provider_ref     text null,
  status           text not null default 'started' check (status in ('started', 'linked', 'failed', 'expired')),
  error            text null,
  document_ids     uuid[] not null default '{}',
  created_at       timestamptz not null default now(),
  linked_at        timestamptz null
);
create index if not exists open_banking_connection_request_idx on open_banking_connection (request_id, created_at);

alter table open_banking_connection enable row level security;
-- The public form route runs as the system (no user bound).
drop policy if exists open_banking_connection_tenant on open_banking_connection;
create policy open_banking_connection_tenant on open_banking_connection for all to public using (true) with check (true);
grant select, insert, update on open_banking_connection to conveyi_automation;

comment on table open_banking_connection is 'A bank connected from a proof-of-funds form; the shared accounts become documents whose facts are statements.';
