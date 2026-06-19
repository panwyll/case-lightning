-- Case-matching engine + premium auto-rules.

-- A stable, GDPR-clean identifier we own and append to outgoing drafts so future
-- replies self-identify their matter — the strongest possible matching signal.
alter table matter add column if not exists case_ref_token text;
update matter set case_ref_token = upper(matter_ref) where case_ref_token is null;

-- Hard structural signals used to NARROW the candidate set before any scoring.
-- We never broad-scan matter content for an unmatched email (data minimisation):
-- only matters surfaced by these identifiers are ever scored.
create table if not exists matter_identifier (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id),
  matter_id uuid not null references matter(id) on delete cascade,
  -- kind: EMAIL | DOMAIN | POSTCODE | NAME | REF_TOKEN
  kind text not null,
  value text not null,
  weight real not null default 1.0,
  created_at timestamptz not null default now(),
  unique (tenant_id, matter_id, kind, value)
);
create index if not exists matter_identifier_lookup_idx on matter_identifier (tenant_id, kind, value);

-- Per-email triage record: the classification, the candidate matches with their
-- scores + rationale, and the decision taken. This is the GDPR/audit surface that
-- makes every match explainable and reversible.
create table if not exists email_triage (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id),
  graph_message_id text,
  graph_conversation_id text,
  matched_matter_id uuid references matter(id),
  confidence real,
  band text,                       -- AUTO | STRONG | WEAK | NONE
  classification jsonb not null default '{}',  -- intent, needsAttention, urgency, reason
  candidates jsonb not null default '[]',      -- [{matterId, score, band, signals[]}]
  decision text not null default 'PENDING',    -- PENDING | CONFIRMED | OVERRIDDEN | AUTO_APPLIED | DISMISSED
  decided_by uuid references app_user(id),
  risk_accepted boolean not null default false,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create index if not exists email_triage_tenant_idx on email_triage (tenant_id, created_at desc);

-- Premium auto-rules. Each rule maps a triage condition to actions. Send-capable
-- rules carry a re-accepted risk acknowledgement (who/when/text) and are off until
-- accepted; a global tenant kill-switch lives in policy_config.
create table if not exists auto_rule (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id),
  name text not null,
  enabled boolean not null default false,
  -- conditions
  intents text[] not null default '{}',        -- e.g. {STATUS_UPDATE}
  min_confidence real not null default 0.9,
  require_no_attention boolean not null default true,
  sender_domains text[] not null default '{}', -- optional allowlist
  -- actions
  do_categorize boolean not null default true,
  category_label text,
  do_assign boolean not null default false,
  assign_to uuid references app_user(id),
  do_append_tracker boolean not null default true,
  -- reply: NONE | DRAFT | SEND
  reply_mode text not null default 'NONE',
  reply_template_id uuid references template(id),
  -- send-rule risk acknowledgement (required + re-accepted whenever a SEND rule is enabled)
  risk_accepted boolean not null default false,
  risk_acknowledgement text,
  risk_accepted_by uuid references app_user(id),
  risk_accepted_at timestamptz,
  created_by uuid references app_user(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Tenant-wide automation kill-switch + send allowlist defaults.
alter table policy_config add column if not exists automation_enabled boolean not null default false;
alter table policy_config add column if not exists auto_send_enabled boolean not null default false;
