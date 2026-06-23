-- Close the Supabase Data API (PostgREST) "other door" (go-live checklist §4a).
--
-- App data is only ever reached through the app's privileged Postgres connection
-- (db.ts, the `postgres` owner) and — for the waitlist/health routes — supabase-js
-- with the service_role key. Both BYPASS row-level security and keep their grants.
-- The risk is the public `anon` / `authenticated` roles that PostgREST exposes over
-- HTTP: on raw-SQL-migration tables RLS is OFF by default, so those roles could read
-- every firm's rows directly, bypassing all the app-layer tenant checks.
--
-- This migration denies those two roles everything in `public` and enables deny-all
-- RLS as belt-and-braces. It does NOT touch the app or waitlist (neither uses anon/
-- authenticated). Reversible: re-GRANT + `disable row level security` if ever needed.

-- 1) Strip Data-API role access to all current objects in public.
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;

-- ...and to anything created later (applies to objects this role creates).
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;

-- 2) Belt-and-braces: deny-all RLS (no policies) on every base table. The table
--    owner (postgres) and service_role bypass RLS, so the app is unaffected; the
--    public roles get nothing even if a grant is ever re-added by mistake.
do $$
declare r record;
begin
  for r in select tablename from pg_tables where schemaname = 'public'
  loop
    execute format('alter table public.%I enable row level security;', r.tablename);
  end loop;
end $$;
