-- 097: the connection role must be able to SET ROLE to conveyi_automation.
--
-- Migration 071 made the app role a member of conveyi_automation so the engine's post-commit
-- effects could run under it. Postgres 16 split role membership from the right to SET ROLE: a
-- grant without the SET option passes pg_has_role(..., 'member') and still refuses SET ROLE
-- ("permission denied to set role"). In production every engine effect (proposals,
-- acknowledgements, search orders) failed on that, silently until the engine started writing
-- its failures on the case. This grants the SET option to whichever role runs the migration
-- (the same role the app connects as) and to the app roles 071 named, where they exist.
do $$
declare r text;
begin
  if current_setting('server_version_num')::int < 160000 then return; end if;
  execute format('grant conveyi_automation to %I with set true', current_user);
  foreach r in array array['conveyi_app', 'app_rls'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('grant conveyi_automation to %I with set true', r);
    end if;
  end loop;
end $$;
