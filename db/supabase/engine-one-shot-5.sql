-- One-shot for Supabase: migration 073 (proof of funds). Idempotent.

-- Proof of funds (docs/proof-of-funds.md).
--
-- The conveyancer fires a tokenised form at the client; the client completes it without
-- logging in; the submission is stored verbatim here and becomes typed facts, a
-- declaration document and a sign-off decision on the engine log. The token is stored
-- hashed (the link is the only secret); rows expire; a follow-up round references the
-- round it re-opens.
create table if not exists proof_of_funds_request (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id),
  matter_id     uuid not null references matter(id) on delete cascade,
  token_hash    text not null unique,
  status        text not null default 'requested' check (status in ('requested', 'submitted', 'expired', 'cancelled')),
  requested_by  uuid null references app_user(id),
  requested_at  timestamptz not null default now(),
  expires_at    timestamptz not null default now() + interval '30 days',
  follow_up_of  uuid null references proof_of_funds_request(id),
  note_to_client text null,
  submitted_at  timestamptz null,
  submission    jsonb null,
  -- the generated declaration document the decision cites
  document_id   uuid null references document(id) on delete set null,
  created_at    timestamptz not null default now()
);
create index if not exists proof_of_funds_request_matter_idx on proof_of_funds_request (tenant_id, matter_id, requested_at desc);

alter table proof_of_funds_request enable row level security;
-- The public form route runs as the system (no user bound); handlers see their matters through the matter wall.
drop policy if exists proof_of_funds_request_tenant on proof_of_funds_request;
create policy proof_of_funds_request_tenant on proof_of_funds_request for all to public using (true) with check (true);

grant select, insert, update on proof_of_funds_request to conveyi_automation;

-- Evidence the client attaches is an ordinary document row (source_type CLIENT_UPLOAD, doc_type
-- PROOF_OF_FUNDS_EVIDENCE) with its bytes in document_blob; nothing new is needed there.
comment on table proof_of_funds_request is 'One row per proof-of-funds form issued to a client; the submission is stored verbatim; the engine log carries the facts, flags and decision.';
