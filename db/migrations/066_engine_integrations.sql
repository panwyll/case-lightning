-- Component #4 (integrations) + #5 (client comms) storage for the conveyancing engine.

-- Orders placed with an external provider (InfoTrack: searches, official copies,
-- ID/AML). The provider's reference is the join key when its webhook calls back, so
-- a result can be routed to the right matter/sub-flow without trusting anything in
-- the webhook body beyond the reference.
create table if not exists integration_order (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id),
  matter_id     uuid not null references matter(id) on delete cascade,
  provider      text not null,                  -- 'infotrack'
  kind          text not null,                  -- search | official_copies | id_check | ap1
  subject       text,                           -- search type / title number / party name
  provider_ref  text not null,                  -- the provider's order id
  status        text not null default 'ORDERED',-- ORDERED | RETURNED | FAILED | CANCELLED
  request       jsonb not null default '{}'::jsonb,
  result        jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (provider, provider_ref)
);
create index if not exists integration_order_matter_idx on integration_order (tenant_id, matter_id, kind);

-- Provider downloads (search PDFs, official copies) are uploaded to the matter's
-- OneDrive folder like any other file. When that is not possible (no folder yet, Graph
-- down) the bytes are kept here so the extraction pipeline can still read them and
-- nothing is lost; a later sync can move them to OneDrive.
create table if not exists document_blob (
  document_id  uuid primary key references document(id) on delete cascade,
  tenant_id    uuid not null references tenant(id),
  bytes        bytea not null,
  created_at   timestamptz not null default now()
);

-- Webhook deliveries, for idempotency (providers retry) and for the audit trail.
create table if not exists integration_webhook (
  id            uuid primary key default gen_random_uuid(),
  provider      text not null,
  delivery_id   text not null,                  -- provider's event/delivery id (or a body hash)
  received_at   timestamptz not null default now(),
  status        text not null,                  -- PROCESSED | IGNORED | FAILED
  detail        text,
  unique (provider, delivery_id)
);

-- Client contact channel for component #5: a phone number (E.164) for WhatsApp, and
-- an opt-in flag so status updates are only ever sent where the client agreed.
alter table matter_contact add column if not exists phone text;
alter table matter_contact add column if not exists whatsapp_opt_in boolean not null default false;

-- Every automated client message and every inbound client question, with the
-- guardrail verdict for questions. The engine's client_update_sent event references
-- these rows by message id.
create table if not exists client_message (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id),
  matter_id     uuid references matter(id) on delete set null,
  direction     text not null,                  -- OUT | IN
  channel       text not null,                  -- whatsapp | email | mock
  address       text,                           -- phone or email
  template      text,                           -- OUT: template key; IN: null
  body          text not null,
  provider_ref  text,                           -- provider message id
  status        text not null,                  -- SENT | FAILED | RECEIVED | ANSWERED | ROUTED_TO_HUMAN
  guard         jsonb,                          -- IN: { verdict, reasons, faqId }
  created_at    timestamptz not null default now()
);
create index if not exists client_message_matter_idx on client_message (tenant_id, matter_id, created_at desc);
create index if not exists client_message_address_idx on client_message (tenant_id, address, created_at desc);
