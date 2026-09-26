-- The automation role could not see most of the database.
--
-- Row-level security is on for every table, but many tables (tenant, app_user, audit_log,
-- usage_event, doc_template, …) have no policy at all. For the app role that is fine —
-- it owns or bypasses RLS — but the engine's post-commit work runs as conveyi_automation
-- (SET LOCAL ROLE, migration 071), and a table with RLS on and no policy returns NO ROWS
-- to that role, silently. So the comms adapter's "matter → tenant → fee earner" lookup
-- found no tenant and threw "Matter not found." on every chase, acknowledgement and
-- client update the timer tried to send, and the engine logged it and moved on.
--
-- This gives the automation role plain access to exactly those policy-less tables. Tables
-- that already have policies (the ethical wall on matter, matter_event, document, …) are
-- untouched: their policies were written deliberately, and the restrictive automation
-- guards from 071 and 079 still apply on top of everything.
do $$
declare r record;
begin
  for r in
    select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
       and not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname)
  loop
    execute format('create policy automation_access on %I for all to public using (current_user = ''conveyi_automation'') with check (current_user = ''conveyi_automation'')', r.relname);
  end loop;
end $$;
