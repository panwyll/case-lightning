-- Ethical wall, second cut: FILTER in lists, RAISE on targeted access.
--
-- 068 made every policy raise. That is right for "handler A asks for matter B", but a
-- tenant-wide list (a handler's own decision feed, the board) legitimately touches the
-- walled row too, and raising there locks the handler out of their own work. Policies
-- now use engine_walled() — true means "not yours, hide it" — so lists simply exclude
-- the other side's matter. Targeted reads keep the explicit 42501: assertMatterAccess
-- (lib/server/guard.ts) calls engine_wall_check() first, which still raises. Writes to
-- a walled row fail RLS's WITH CHECK (42501) as before.

create or replace function engine_walled(p_matter uuid) returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(current_setting('app.user_id', true), '') <> ''
     and exists (select 1 from engine_linked_handler(p_matter) h where h::text = current_setting('app.user_id', true))
$$;

do $$
declare t text;
begin
  foreach t in array array['matter_summary','matter_engine_state','matter_event','matter_decision','document','client_message','matter_task','matter_timeline_event','kb_chunk','email_thread','email_message','integration_order','matter_contact'] loop
    if to_regclass(t) is not null then
      execute format('drop policy if exists engine_wall on %I', t);
      execute format('create policy engine_wall on %I for all using (not engine_walled(matter_id)) with check (not engine_walled(matter_id))', t);
    end if;
  end loop;
end $$;

drop policy if exists engine_wall on document_blob;
create policy engine_wall on document_blob for all
  using (not engine_walled((select d.matter_id from document d where d.id = document_blob.document_id)))
  with check (not engine_walled((select d.matter_id from document d where d.id = document_blob.document_id)));

drop policy if exists engine_wall on matter;
create policy engine_wall on matter for all using (not engine_walled(id)) with check (not engine_walled(id));
