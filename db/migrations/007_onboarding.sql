-- Onboarding: bulk-import the cases already in flight in a user's mailbox.
--
-- A resumable, user-scoped job advances in small, timeout-safe steps:
--   SCANNING → CLUSTERING → PROPOSING → AWAITING_REVIEW
--     → (user confirms selections) → PROVISIONING → COMPLETED
-- The fetched backlog and the proposed cases are staged here so the job can be
-- driven one bounded slice at a time (taskpane poll, or the resume cron) and
-- resume cleanly after a stall. Strictly tenant- and user-scoped, like the rest
-- of the schema.

create table if not exists onboarding_job (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id),
  user_id uuid not null references app_user(id),
  status text not null default 'SCANNING',
  lookback_months int,                 -- null = unlimited (premium)
  since timestamptz,                   -- null = no lower bound (unlimited)
  scan_cursor text,                    -- Graph @odata.nextLink for the next page
  messages_scanned int not null default 0,
  threads_found int not null default 0,
  cases_proposed int not null default 0,
  cases_onboarded int not null default 0,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz
);

create index if not exists onboarding_job_user_idx on onboarding_job (user_id, status, created_at desc);

-- Lightweight staging of the fetched backlog (no full bodies — preview + signals only).
create table if not exists onboarding_message (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references onboarding_job(id) on delete cascade,
  tenant_id uuid not null references tenant(id),
  graph_message_id text not null,
  graph_conversation_id text,
  subject text,
  from_address text,
  participants text[] not null default '{}',
  received_at timestamptz,
  body_preview text,
  postcodes text[] not null default '{}',
  has_attachments boolean not null default false,
  cluster_key text,
  created_at timestamptz not null default now(),
  unique (job_id, graph_message_id)
);

create index if not exists onboarding_message_cluster_idx on onboarding_message (job_id, cluster_key);

-- A proposed case = one discovered cluster of related emails.
create table if not exists onboarding_case (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references onboarding_job(id) on delete cascade,
  tenant_id uuid not null references tenant(id),
  cluster_key text not null,
  proposed_matter_ref text,
  property_address text,
  buyer_names text[] not null default '{}',
  seller_names text[] not null default '{}',
  counterparty_solicitor text,
  counterparty_agent text,
  confidence numeric,
  rationale text,
  thread_count int not null default 0,
  message_count int not null default 0,
  conversation_ids text[] not null default '{}',
  status text not null default 'PROPOSED',  -- PROPOSED|APPROVED|REJECTED|ONBOARDED|FAILED
  matter_id uuid references matter(id),
  edits jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (job_id, cluster_key)
);

create index if not exists onboarding_case_job_idx on onboarding_case (job_id, status);
