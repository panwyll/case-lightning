-- Tasks a person has taken out of the tray (not needed on this case). They stay listed under
-- Dismissed and can be restored; restoring clears restored_at-less rows for that task.
create table if not exists task_dismissal (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  matter_id uuid not null,
  ref text not null,             -- decision:<eventId> | step:<key> | issue:<id> | wait:<key:subject>
  title text,
  dismissed_by uuid,
  dismissed_at timestamptz not null default now(),
  restored_at timestamptz
);
create index if not exists task_dismissal_live_idx on task_dismissal (tenant_id, matter_id) where restored_at is null;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'conveyi_automation') then
    grant select on task_dismissal to conveyi_automation;
  end if;
end $$;
