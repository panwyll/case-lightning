-- LEAP as the backend (phase 0/1).
--
-- LEAP (leap.build) becomes the system of record for matters, parties, documents,
-- tasks and file notes. CONVEYi keeps the proprietary spine — the event log, the
-- machine, decisions, bank details, audit — and MIRRORS just enough of LEAP into its
-- own tables to run it: a matter row (the engine's foreign key, the wall's subject),
-- document metadata (bytes fetched from LEAP on demand), and contacts (for the
-- counterparty resolver and comms). Every mirrored row carries the LEAP id it came from.

-- One connection per firm: OAuth tokens (encrypted with APP_ENCRYPTION_KEY), the LEAP
-- firm id, and the sync watermarks.
create table if not exists leap_connection (
  tenant_id        uuid primary key references tenant(id) on delete cascade,
  firm_id          text,
  firm_name        text,
  region           text,
  tokens_enc       text,                                   -- encryptSecret(JSON LeapTokens)
  status           text not null default 'DISCONNECTED',   -- CONNECTED | DISCONNECTED | ERROR
  status_detail    text,
  webhook_sub_id   text,
  matters_since    timestamptz,                            -- watermark for matter polling
  last_sync_at     timestamptz,
  last_sync_detail jsonb,
  connected_by     uuid references app_user(id),
  connected_at     timestamptz,
  updated_at       timestamptz not null default now()
);

-- Where each mirrored row came from.
alter table matter add column if not exists leap_matter_id text;
alter table matter add column if not exists leap_synced_at timestamptz;
alter table matter add column if not exists leap_documents_since timestamptz;  -- watermark for document polling per matter
create unique index if not exists matter_leap_id_idx on matter (tenant_id, leap_matter_id) where leap_matter_id is not null;

alter table document add column if not exists leap_document_id text;
-- Documents arrive in LEAP in any order (a search result before the ID check has cleared):
-- one the engine cannot take yet stays PENDING and is retried on every sync until it is
-- DONE (handed to a sub-flow) or SKIPPED (nothing for the engine in it).
alter table document add column if not exists leap_ingest_status text;   -- PENDING | DONE | SKIPPED
alter table document add column if not exists leap_ingest_detail text;
alter table document add column if not exists leap_ingest_attempts int not null default 0;
create index if not exists document_leap_ingest_idx on document (tenant_id, matter_id) where leap_ingest_status = 'PENDING';
create unique index if not exists document_leap_id_idx on document (tenant_id, leap_document_id) where leap_document_id is not null;

alter table matter_contact add column if not exists leap_card_id text;
alter table matter_contact add column if not exists leap_role text;

-- What we wrote back into LEAP for an engine event, so it can be completed/updated later
-- and never written twice.
create table if not exists leap_writeback (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  matter_id     uuid not null references matter(id) on delete cascade,
  event_id      uuid not null references matter_event(id),
  kind          text not null,        -- task | note | document | status
  leap_id       text,                 -- the LEAP task/note/document id
  status        text not null default 'WRITTEN',   -- WRITTEN | COMPLETED | FAILED
  detail        text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (event_id, kind)
);
create index if not exists leap_writeback_matter_idx on leap_writeback (tenant_id, matter_id);

-- The wall applies to the mirror like everything else on a matter.
alter table leap_writeback enable row level security;
alter table leap_writeback force row level security;
drop policy if exists engine_wall on leap_writeback;
create policy engine_wall on leap_writeback for all using (not engine_walled(matter_id)) with check (not engine_walled(matter_id));
grant select, insert, update, delete on leap_connection, leap_writeback to conveyi_automation;

comment on table leap_connection is 'One LEAP (leap.build) connection per firm: OAuth tokens (encrypted), firm id, sync watermarks.';
comment on column matter.leap_matter_id is 'LEAP matter id this row mirrors. LEAP is the system of record for matter fields; the engine log stays here.';
