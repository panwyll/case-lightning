-- InfoTrack per firm (docs/infotrack-integration.md).
--
-- Each firm orders searches, official copies and ID checks on its OWN InfoTrack account:
-- the orders are billed to it and appear in its InfoTrack (and, where InfoTrack is linked,
-- its LEAP or InTouch). The admin enters the account's API credentials on the InfoTrack
-- page; they are stored encrypted with APP_ENCRYPTION_KEY, like InTouch's. The INFOTRACK_*
-- env vars remain only as a fallback for a deployment that serves one firm.
create table if not exists infotrack_connection (
  tenant_id       uuid primary key references tenant(id) on delete cascade,
  credentials_enc text,                                 -- encryptSecret(JSON InfoTrackFirmCredentials)
  status          text not null default 'DISCONNECTED', -- CONNECTED | DISCONNECTED | ERROR
  status_detail   text,
  connected_by    uuid references app_user(id),
  connected_at    timestamptz,
  updated_at      timestamptz not null default now()
);

alter table infotrack_connection enable row level security;
-- Orders are placed by the engine and results arrive by webhook, both as the automation role with no user bound.
drop policy if exists infotrack_connection_all on infotrack_connection;
create policy infotrack_connection_all on infotrack_connection for all to public using (true) with check (true);
grant select, insert, update, delete on infotrack_connection to conveyi_automation;

comment on table infotrack_connection is 'One InfoTrack account per firm: API credentials (encrypted), the key its result webhook URL carries, and whether it is connected.';
