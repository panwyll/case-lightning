-- ============================================================================
-- CONVEYi conveyancing engine — ONE-SHOT for the Supabase SQL editor
--
-- Bundles db/migrations 065–068 verbatim (engine event log, integrations +
-- comms tables, hash chain, internal-counterparty ethical wall) and records
-- them in schema_migrations so `npm run migrate` will not re-apply them.
-- Idempotent: safe to run more than once. Runs in a single transaction.
--
-- Requires the existing schema (migrations ≤ 064 already applied).
--
-- AFTER RUNNING: the ethical wall (068) is row-level security. The role the app
-- connects with must NOT have BYPASSRLS or superuser, or the wall silently does
-- not apply. Supabase's default `postgres` role bypasses RLS — see
-- db/supabase/app-role.sql to create a dedicated app role and point DATABASE_URL
-- at it, then confirm GET /api/v1/health returns "wallEnforced": true.
-- ============================================================================
begin;

create table if not exists schema_migrations (
  filename text primary key,
  applied_at timestamptz not null default now()
);

-- ────────────────────────────────────────────────────────────────────────────
-- 065_conveyance_engine.sql
-- ────────────────────────────────────────────────────────────────────────────
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

-- ────────────────────────────────────────────────────────────────────────────
-- 066_engine_integrations.sql
-- ────────────────────────────────────────────────────────────────────────────
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

-- ────────────────────────────────────────────────────────────────────────────
-- 067_engine_hash_chain.sql
-- ────────────────────────────────────────────────────────────────────────────
-- Component #7: tamper-evidence for the engine's event log.
--
-- Every matter_event now carries a SHA-256 over its own canonical content plus the
-- previous event's hash (a per-matter hash chain, genesis prev_hash = ''). Together
-- with the append-only trigger (065) this means: a row cannot be changed in place, and
-- a row cannot be removed, reordered or inserted without every later hash failing
-- verification (lib/server/engine/audit.ts verifyChain). The chain is recomputed and
-- checked on every audit export and by scripts/engine-audit.ts.
alter table matter_event add column if not exists prev_hash text;
alter table matter_event add column if not exists hash text;
create index if not exists matter_event_hash_idx on matter_event (matter_id, hash);

comment on column matter_event.hash is 'sha256(prev_hash || canonical(event)); see lib/server/engine/audit.ts';

-- ────────────────────────────────────────────────────────────────────────────
-- 068_internal_counterparties.sql
-- ────────────────────────────────────────────────────────────────────────────
-- Addendum: internally-linked counterparties.
--
-- The firm may act for the buyer on matter A and, through a DIFFERENT handler, for the
-- seller on matter B in the same chain. That is permitted only if the two handlers are
-- walled off from each other exactly as if they were separate firms. This migration
-- puts the wall in the DATABASE, where a shared backend function, a debug query or a
-- casually used admin screen cannot step around it:
--
--   matter.counterparty_ref  — who is on the other side: an external party, or an
--                              internal matter id (resolved by lib/server/engine/counterparty.ts)
--   matter_link              — the internal link itself (unordered pair), with a trigger
--                              that REJECTS a link whose two matters share a handler
--   matter assigned_to trig  — REJECTS reassigning a matter to the handler of its linked
--                              counterparty
--   engine_wall_check()      — raises insufficient_privilege (42501) when the current
--                              application user (set per query via app.user_id) is the
--                              handler of the counterparty of the row being read
--   row-level security       — every table holding a matter's confidential facts calls
--                              engine_wall_check; FORCE so the table owner is bound too
--
-- The application sets app.user_id with set_config(..., true) inside a transaction for
-- every query made on behalf of a signed-in user (lib/server/db.ts). Queries made by the
-- system itself (cron, webhooks, the engine's own effects) carry no user and are not
-- walled: the wall is between PEOPLE. The database role the app connects with must NOT
-- have BYPASSRLS (GET /api/v1/health reports `wallEnforced`).

-- (assigned_to — the handler — normally exists from 006; guarded so this migration is self-contained)
alter table matter add column if not exists assigned_to uuid references app_user(id);
alter table matter add column if not exists counterparty_ref jsonb;
comment on column matter.counterparty_ref is
  'CounterpartyRef: {"kind":"external","name":..,"email":..,"firm":..} or {"kind":"internal","matterId":..}. See lib/server/engine/counterparty.ts.';

create table if not exists matter_link (
  tenant_id   uuid not null references tenant(id),
  matter_a    uuid not null references matter(id) on delete cascade,
  matter_b    uuid not null references matter(id) on delete cascade,
  chain_ref   text,
  created_by  uuid references app_user(id),
  created_at  timestamptz not null default now(),
  primary key (matter_a, matter_b),
  check (matter_a < matter_b)
);
create index if not exists matter_link_b_idx on matter_link (matter_b);

-- The handler of the OTHER side of a matter (empty when not internally linked / unassigned).
-- SECURITY DEFINER: the wall's own lookup must read matter/matter_link without the wall
-- policy applying to it (otherwise the policy recurses into itself). The function owner
-- (the migration role) is the only principal that reads across, and only these two ids.
create or replace function engine_linked_handler(p_matter uuid) returns setof uuid language sql stable security definer set search_path = public as $$
  select m.assigned_to
    from matter_link l
    join matter m on m.id = case when l.matter_a = p_matter then l.matter_b else l.matter_a end
   where (l.matter_a = p_matter or l.matter_b = p_matter) and m.assigned_to is not null
$$;

-- Requirement 5: one handler can never be on both sides of a link. Hard error, not a warning.
create or replace function matter_link_no_shared_handler() returns trigger language plpgsql as $$
declare ha uuid; hb uuid;
begin
  select assigned_to into ha from matter where id = new.matter_a;
  select assigned_to into hb from matter where id = new.matter_b;
  if ha is not null and ha = hb then
    raise exception 'conflict of interest: the same handler (%) is assigned to both linked matters % and %', ha, new.matter_a, new.matter_b using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists matter_link_no_shared_handler_trg on matter_link;
create trigger matter_link_no_shared_handler_trg before insert or update on matter_link
  for each row execute function matter_link_no_shared_handler();

create or replace function matter_assign_no_conflict() returns trigger language plpgsql as $$
begin
  if new.assigned_to is not null and new.assigned_to is distinct from old.assigned_to
     and exists (select 1 from engine_linked_handler(new.id) h where h = new.assigned_to) then
    raise exception 'conflict of interest: handler % already acts for the counterparty of matter %', new.assigned_to, new.id using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists matter_assign_no_conflict_trg on matter;
create trigger matter_assign_no_conflict_trg before update of assigned_to on matter
  for each row execute function matter_assign_no_conflict();

-- Requirement 2: the wall. Raises rather than filtering so a crossing is an ERROR the
-- caller (and the audit log) sees, never an empty result that looks like "no data".
create or replace function engine_wall_check(p_matter uuid) returns boolean language plpgsql stable security definer set search_path = public as $$
declare who text := current_setting('app.user_id', true);
begin
  if who is null or who = '' then return true; end if;              -- system context
  if exists (select 1 from engine_linked_handler(p_matter) h where h::text = who) then
    raise exception 'ethical wall: user % may not read matter % (handler of the counterparty)', who, p_matter using errcode = '42501';
  end if;
  return true;
end $$;

-- Apply the wall to every table that carries a matter's confidential facts.
do $$
declare t text;
begin
  foreach t in array array['matter_summary','matter_engine_state','matter_event','matter_decision','document','client_message','matter_task','matter_timeline_event','kb_chunk','email_thread','email_message','integration_order','matter_contact'] loop
    if to_regclass(t) is not null then
      execute format('alter table %I enable row level security', t);
      execute format('alter table %I force row level security', t);
      execute format('drop policy if exists engine_wall on %I', t);
      execute format('create policy engine_wall on %I for all using (engine_wall_check(matter_id)) with check (engine_wall_check(matter_id))', t);
    end if;
  end loop;
end $$;

-- document_blob has no matter_id of its own: walled through its document.
alter table document_blob enable row level security;
alter table document_blob force row level security;
drop policy if exists engine_wall on document_blob;
create policy engine_wall on document_blob for all
  using (engine_wall_check((select d.matter_id from document d where d.id = document_blob.document_id)))
  with check (engine_wall_check((select d.matter_id from document d where d.id = document_blob.document_id)));

-- The matter row itself (notes, prices, parties).
alter table matter enable row level security;
alter table matter force row level security;
drop policy if exists engine_wall on matter;
create policy engine_wall on matter for all using (engine_wall_check(id)) with check (engine_wall_check(id));

-- Requirement 4: compliance reviews pull every event that crossed to an internal
-- counterparty without reconstructing it from the payloads.
create index if not exists matter_event_counterparty_idx on matter_event ((payload->>'counterpartyType')) where payload ? 'counterpartyType';

-- ────────────────────────────────────────────────────────────────────────────
-- Record the four files so the repo's migration runner treats them as applied.
-- ────────────────────────────────────────────────────────────────────────────
insert into schema_migrations (filename) values
  ('065_conveyance_engine.sql'),
  ('066_engine_integrations.sql'),
  ('067_engine_hash_chain.sql'),
  ('068_internal_counterparties.sql')
on conflict (filename) do nothing;

commit;

-- Sanity check (read-only): expect 4 rows, 15 wall policies, and the immutability trigger.
select
  (select count(*) from schema_migrations where filename in ('065_conveyance_engine.sql','066_engine_integrations.sql','067_engine_hash_chain.sql','068_internal_counterparties.sql')) as engine_migrations_recorded,
  (select count(*) from pg_policies where policyname = 'engine_wall') as wall_policies,
  (select count(*) from pg_trigger where tgname = 'matter_event_no_update') as immutability_trigger;
