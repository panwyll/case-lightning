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
