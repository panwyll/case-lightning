-- Server errors, for the owner's console (/internal → Errors): what failed, where, and why.
-- Written best-effort by lib/server/error-log.ts from API routes (5xx) and the engine's warnings.
create table if not exists app_error (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  source text not null,          -- api | engine | cron | webhook
  route text,                    -- e.g. matters/[matterId]/engine
  status int,
  message text not null,
  detail text,                   -- the top of the stack, or the context line
  tenant_id uuid,
  matter_id uuid
);
create index if not exists app_error_created_idx on app_error (created_at desc);

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'conveyi_automation') then
    grant select, insert on app_error to conveyi_automation;
  end if;
end $$;
