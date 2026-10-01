-- The client portal (docs/spec/ui.md "Client portal").
--
-- One link per case for the client: where things stand, what we need from them, and their
-- documents. Like a secure file link, it opens with a six-digit code emailed to the client's
-- address on the case (stored hashed, 15 minutes, five tries). The token is stored hashed for the
-- lookup and encrypted so the same link can go in every email. Resetting it revokes the old link.
create table if not exists client_portal (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenant(id),
  matter_id        uuid not null references matter(id) on delete cascade,
  token_hash       text not null unique,
  token_enc        text not null,
  created_at       timestamptz not null default now(),
  revoked_at       timestamptz null,
  code_hash        text null,
  code_expires_at  timestamptz null,
  code_attempts    int not null default 0,
  codes_sent       int not null default 0,
  code_sent_at     timestamptz null,
  first_opened_at  timestamptz null,
  last_opened_at   timestamptz null,
  opens            int not null default 0,
  uploads          int not null default 0
);
-- One live link per case.
create unique index if not exists client_portal_live_idx on client_portal (matter_id) where revoked_at is null;
create index if not exists client_portal_tenant_idx on client_portal (tenant_id, matter_id);

alter table client_portal enable row level security;
-- The portal's public routes run as the system (no user bound).
drop policy if exists client_portal_all on client_portal;
create policy client_portal_all on client_portal for all to public using (true) with check (true);
grant select, insert, update on client_portal to conveyi_automation;

comment on table client_portal is 'One live client portal link per case; token hashed (and encrypted for re-sending), code hashed; opens and uploads counted.';
