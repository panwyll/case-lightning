-- Billing: a 7-day grace period after a failed payment, a suspended mode after it (reading
-- allowed, nothing sent, no AI), a clean catch-up when they pay, and comps with an end date.

-- Mail that arrived while the firm was suspended: held here (not read, not dropped) and
-- processed when they resume.
create table if not exists held_mail (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  user_id uuid not null,
  message_id text not null,
  received_at timestamptz not null default now(),
  unique (tenant_id, user_id, message_id)
);
create index if not exists held_mail_tenant_idx on held_mail (tenant_id, received_at);

-- A comp can end on a date (then the firm is on its trial, or pays). Null = open-ended.
alter table billing_account add column if not exists comp_until timestamptz;

-- The engine's automation role (when it exists) reads and clears held mail too.
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'conveyi_automation') then
    grant select, insert, delete on held_mail to conveyi_automation;
  end if;
end $$;
