-- ============================================================================
-- Dedicated application role for CONVEYi (run once, as postgres, in the Supabase
-- SQL editor). Needed so the ethical wall (row-level security, migration 068)
-- actually applies: Supabase's `postgres` role has BYPASSRLS.
--
-- 1. Replace the password below, run this file.
-- 2. Point DATABASE_URL at the new role. Via the Supabase pooler the username is
--    `conveyi_app.<project-ref>`, e.g.
--    postgres://conveyi_app.abcdefghijklmnop:<password>@aws-0-eu-west-2.pooler.supabase.com:6543/postgres
-- 3. Redeploy and check GET /api/v1/health → "wallEnforced": true.
--
-- Migrations (npm run migrate) should keep running as postgres — the wall's helper
-- functions are SECURITY DEFINER and must be owned by a role that can read across.
-- ============================================================================
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'conveyi_app') then
    create role conveyi_app login password 'CHANGE-ME-long-random-password' nobypassrls nosuperuser;
  end if;
end $$;

grant usage on schema public to conveyi_app;
grant select, insert, update, delete on all tables in schema public to conveyi_app;
grant usage, select on all sequences in schema public to conveyi_app;
grant execute on all functions in schema public to conveyi_app;
-- Future tables created by migrations (run as postgres) stay accessible:
alter default privileges for role postgres in schema public grant select, insert, update, delete on tables to conveyi_app;
alter default privileges for role postgres in schema public grant usage, select on sequences to conveyi_app;
alter default privileges for role postgres in schema public grant execute on functions to conveyi_app;

-- Verify: should be f, f
select rolname, rolbypassrls, rolsuper from pg_roles where rolname = 'conveyi_app';
