-- InTouch (docs/intouch-integration.md).
--
-- InTouch is the client-facing half of a firm's stack: onboarding, identity checks, the
-- property forms the client fills in online, and the portal the client and the estate
-- agent watch. CONVEYi takes facts from it, and pushes the true state of the case back as
-- a milestone so nobody retypes it.
--
-- One connection per firm; tokens encrypted with APP_ENCRYPTION_KEY, exactly as LEAP's.
create table if not exists intouch_connection (
  tenant_id          uuid primary key references tenant(id) on delete cascade,
  account_id         text,
  account_name       text,
  tokens_enc         text,                                 -- encryptSecret(JSON InTouchTokens)
  status             text not null default 'DISCONNECTED', -- CONNECTED | DISCONNECTED | ERROR
  status_detail      text,
  webhook_sub_id     text,
  cases_since        timestamptz,                          -- watermark for case polling
  -- Pushing milestones writes to something the CLIENT sees, so it is off until the firm
  -- turns it on. Reading is harmless; writing to a client's portal is not.
  milestones_enabled boolean not null default false,
  last_sync_at       timestamptz,
  last_sync_detail   jsonb,
  connected_by       uuid references app_user(id),
  connected_at       timestamptz,
  updated_at         timestamptz not null default now()
);

-- Where each mirrored row came from.
alter table matter add column if not exists intouch_case_id text;
alter table matter add column if not exists intouch_synced_at timestamptz;
-- The last milestone pushed to the client portal, so the same one is never sent twice
-- and the case can never be shown going backwards.
alter table matter add column if not exists intouch_milestone text;
create unique index if not exists matter_intouch_id_idx on matter (tenant_id, intouch_case_id) where intouch_case_id is not null;

alter table document add column if not exists intouch_document_id text;
create unique index if not exists document_intouch_id_idx on document (tenant_id, intouch_document_id) where intouch_document_id is not null;

alter table matter_contact add column if not exists intouch_party_id text;

-- Every InTouch fact we have already applied, keyed on ITS id. An identity check, a
-- completed form or an upload must become an engine event exactly once, however many
-- times a webhook fires or a sync re-reads the case.
create table if not exists intouch_applied (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id) on delete cascade,
  matter_id   uuid references matter(id) on delete cascade,
  kind        text not null,      -- identity_check | form | document | milestone
  external_id text not null,
  detail      text,
  applied_at  timestamptz not null default now()
);
create unique index if not exists intouch_applied_key on intouch_applied (tenant_id, kind, external_id);
create index if not exists intouch_applied_matter_idx on intouch_applied (tenant_id, matter_id, applied_at desc);

alter table intouch_connection enable row level security;
alter table intouch_applied enable row level security;
-- The sync and the webhook run as the automation role with no user bound, like LEAP's.
drop policy if exists intouch_connection_all on intouch_connection;
create policy intouch_connection_all on intouch_connection for all to public using (true) with check (true);
drop policy if exists intouch_applied_all on intouch_applied;
create policy intouch_applied_all on intouch_applied for all to public using (true) with check (true);

grant select, insert, update, delete on intouch_connection, intouch_applied to conveyi_automation;

comment on table intouch_connection is 'One InTouch connection per firm: OAuth tokens (encrypted), account id, sync watermark, and whether milestones are pushed to the client portal.';
comment on table intouch_applied is 'Idempotency ledger: every InTouch fact already turned into an engine event, keyed on InTouch''s own id.';
