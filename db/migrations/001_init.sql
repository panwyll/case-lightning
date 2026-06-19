-- CaseLightning core schema.
-- Backend system of record for matter metadata, RAG vectors and audit. The
-- user-facing source of truth (per-case OneDrive folder + Excel tracker) lives
-- in the user's M365 drive; this DB is the invisible backend.

create extension if not exists vector;
create extension if not exists pgcrypto;

create table if not exists tenant (
  id uuid primary key default gen_random_uuid(),
  external_tenant_id text unique,
  name text not null,
  created_at timestamptz not null default now()
);

do $$ begin
  create type user_role as enum ('ADMIN', 'CONVEYANCER', 'ASSISTANT', 'READ_ONLY');
exception when duplicate_object then null; end $$;

create table if not exists app_user (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id),
  entra_object_id text not null unique,
  email text not null,
  display_name text,
  role user_role not null,
  graph_access_token text,
  graph_refresh_token text,
  token_expires_at timestamptz,
  -- Optional per-user BYOK AI key (AES-256-GCM encrypted). Central key is the default.
  ai_api_key_enc text,
  ai_key_updated_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists matter (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id),
  matter_ref text not null,
  property_address text not null,
  buyer_names text[] not null default '{}',
  seller_names text[] not null default '{}',
  counterparty_solicitor text,
  counterparty_agent text,
  lender text,
  chain_position text,
  exchange_target_date date,
  completion_target_date date,
  status text not null default 'OPEN',
  confidentiality_tag text not null default 'STANDARD',
  -- OneDrive (Graph) location of the per-case knowledge base folder
  drive_id text,
  folder_item_id text,
  folder_path text,
  folder_web_url text,
  -- The live Excel case tracker that lives in the matter folder
  tracker_item_id text,
  tracker_web_url text,
  created_by uuid not null references app_user(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, matter_ref)
);

create table if not exists email_thread (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id),
  matter_id uuid not null references matter(id),
  graph_thread_id text not null,
  graph_conversation_id text,
  subject text,
  participants jsonb not null default '[]',
  last_message_at timestamptz,
  outlook_category text,
  created_at timestamptz not null default now(),
  unique (tenant_id, graph_thread_id)
);

create table if not exists email_message (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id),
  matter_id uuid not null references matter(id),
  thread_id uuid not null references email_thread(id),
  graph_message_id text not null,
  internet_message_id text,
  sender text,
  recipients jsonb not null default '[]',
  sent_at timestamptz,
  received_at timestamptz,
  body_text text,
  body_html text,
  sender_domain text,
  confidentiality_tag text,
  ingestion_status text not null default 'INGESTED',
  created_at timestamptz not null default now(),
  unique (tenant_id, graph_message_id)
);

create table if not exists document (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id),
  matter_id uuid not null references matter(id),
  source_type text not null,
  drive_id text,
  graph_item_id text,
  storage_path text not null,
  web_url text,
  file_name text not null,
  mime_type text,
  size_bytes bigint,
  version_label text,
  hash_sha256 text,
  doc_type text,
  sender_domain text,
  confidentiality_tag text,
  doc_date date,
  created_by uuid references app_user(id),
  created_at timestamptz not null default now()
);

create table if not exists matter_summary (
  matter_id uuid primary key references matter(id),
  tenant_id uuid not null references tenant(id),
  facts jsonb not null default '{}',
  outstanding_items jsonb not null default '[]',
  risks jsonb not null default '[]',
  updated_at timestamptz not null default now()
);

create table if not exists matter_timeline_event (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id),
  matter_id uuid not null references matter(id),
  event_at timestamptz,
  event_type text not null,
  title text not null,
  details text,
  source_ref jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists template (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id),
  name text not null,
  category text not null,
  subject_template text,
  body_template text not null,
  style_tag text not null default 'NEUTRAL',
  policy_tags text[] not null default '{}',
  is_active boolean not null default true,
  created_by uuid references app_user(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Retrieval chunks. Dimension matches the configured embeddings model
-- (voyage-3-large = 1024). Switching to OpenAI text-embedding-3-large (3072)
-- requires altering this column and re-embedding.
create table if not exists kb_chunk (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id),
  matter_id uuid references matter(id),
  source_kind text not null,
  source_id uuid,
  chunk_text text not null,
  metadata jsonb not null default '{}',
  embedding vector(1024),
  created_at timestamptz not null default now()
);

create index if not exists kb_chunk_scope_idx on kb_chunk (tenant_id, matter_id, source_kind);

create table if not exists audit_log (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id),
  matter_id uuid,
  actor_user_id uuid references app_user(id),
  action_type text not null,
  action_status text not null,
  request_id text,
  trace_id text,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists audit_tenant_matter_idx on audit_log (tenant_id, matter_id, created_at desc);
