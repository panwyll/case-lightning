-- CONVEYi conveyancing engine (lib/server/engine): the event-sourced state machine
-- that runs a residential freehold purchase (buyer-side).
--
-- matter_event is the SOURCE OF TRUTH: an immutable, per-matter, gap-free log.
-- Everything else here is a read model rebuilt from it (matter_engine_state,
-- matter_decision) or a small config table (engine_sla_override). Current state is
-- a projection of the log, never a separately-updated column — that is what gives
-- the audit trail for free (spec §2.1, §7).

-- ── The log ──────────────────────────────────────────────────────────────────
create table if not exists matter_event (
  id                  uuid primary key,
  tenant_id           uuid not null references tenant(id),
  matter_id           uuid not null references matter(id) on delete restrict,
  seq                 bigint not null,                   -- 1-based, gap-free per matter
  type                text not null,                     -- engine EventType (types.ts)
  actor               text not null,                     -- 'system' | 'ai' | 'external' | app_user.id
  payload             jsonb not null default '{}'::jsonb,
  source_document_id  uuid references document(id),
  confidence_score    numeric(4,3),                      -- extraction/AI confidence, 0–1
  caused_by_event_id  uuid references matter_event(id),
  created_at          timestamptz not null default now(),
  unique (matter_id, seq)
);
create index if not exists matter_event_matter_idx on matter_event (tenant_id, matter_id, seq);
create index if not exists matter_event_type_idx on matter_event (tenant_id, type, created_at desc);

-- Immutability, enforced in the database not just by convention.
create or replace function matter_event_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'matter_event is append-only (% on % is not allowed)', tg_op, tg_table_name;
end $$;
drop trigger if exists matter_event_no_update on matter_event;
create trigger matter_event_no_update before update or delete on matter_event
  for each row execute function matter_event_immutable();

-- ── Read models (rebuildable from matter_event) ──────────────────────────────
create table if not exists matter_engine_state (
  matter_id    uuid primary key references matter(id) on delete cascade,
  tenant_id    uuid not null references tenant(id),
  stage        text not null,
  last_seq     bigint not null default 0,
  state        jsonb not null,                           -- MatterState (types.ts)
  finished_at  timestamptz,                               -- set once AP1 is confirmed
  updated_at   timestamptz not null default now()
);
create index if not exists matter_engine_state_active_idx on matter_engine_state (tenant_id, updated_at) where finished_at is null;

-- DecisionEvent (spec §2.2): one row per decision-bearing event, kept in sync with the
-- projection. source_document_id is NOT NULL on purpose — every decision cites a source.
create table if not exists matter_decision (
  event_id            uuid primary key references matter_event(id),
  tenant_id           uuid not null references tenant(id),
  matter_id           uuid not null references matter(id) on delete cascade,
  kind                text not null,                     -- search | enquiry | mortgage | title | id_check | report_on_title | escalation
  status              text not null,                     -- pending | actioned | escalated
  summary             text not null,
  source_document_id  uuid not null references document(id),
  options             jsonb not null default '[]'::jsonb,
  resolved_by         text,                              -- app_user.id
  resolved_at         timestamptz,
  resolution          text,
  decision            jsonb not null,                    -- the full DecisionState
  created_at          timestamptz not null default now()
);
create index if not exists matter_decision_pending_idx on matter_decision (tenant_id, created_at) where status = 'pending';
create index if not exists matter_decision_matter_idx on matter_decision (matter_id, status);

-- ── SLA overrides (spec §2.6 "configurable") ────────────────────────────────
-- Defaults live in code (sla.ts DEFAULT_SLA); a row here overrides a wait's numbers
-- for one firm. Working days, England & Wales.
create table if not exists engine_sla_override (
  tenant_id          uuid not null references tenant(id) on delete cascade,
  wait_key           text not null,                      -- id_check | search | enquiry | funds | registration
  chase_after        int,
  chase_every        int,
  escalate_after     int,
  re_escalate_after  int,
  primary key (tenant_id, wait_key)
);

-- ── Existing tables ──────────────────────────────────────────────────────────
-- The transaction type the engine runs. Only 'freehold_purchase' is automated in v1;
-- set on enrolment. Null = the matter is not (yet) engine-driven.
alter table matter add column if not exists transaction_type text;

-- Typed output of the extraction pipeline (#2), per spec §2.2 Document. The engine's
-- stub extractor reads these; the real pipeline will write them.
alter table document add column if not exists extracted_facts jsonb;
alter table document add column if not exists extraction_confidence numeric(4,3);

comment on table matter_event is 'Append-only event log for the conveyancing engine. Current matter state is a projection of this table.';
comment on table matter_decision is 'Decision events awaiting/after human action. Read model of matter_event; every row cites a source document.';
comment on column document.extracted_facts is 'Structured facts from the document extraction pipeline (engine types: SearchFacts / MortgageOfferFacts / TitleFacts / EnquiryReplyFacts / IdCheckFacts).';
