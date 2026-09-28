-- 106: the firm signs off the rulebook. Each sign-off records the version and every rule's hash,
-- so a rule whose words change afterwards shows as changed until the firm signs again.
create table if not exists rulebook_signoff (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id) on delete cascade,
  version text not null,
  rule_hashes jsonb not null,
  signed_by uuid references app_user(id) on delete set null,
  signed_at timestamptz not null default now(),
  note text
);
create index if not exists rulebook_signoff_tenant on rulebook_signoff (tenant_id, signed_at desc);
alter table rulebook_signoff enable row level security;
drop policy if exists rulebook_signoff_wall on rulebook_signoff;
create policy rulebook_signoff_wall on rulebook_signoff for all to public
  using (tenant_id = (select tenant_id from app_user where id::text = current_setting('app.user_id', true)) or current_setting('app.user_id', true) is null or current_setting('app.user_id', true) = '')
  with check (tenant_id = (select tenant_id from app_user where id::text = current_setting('app.user_id', true)) or current_setting('app.user_id', true) is null or current_setting('app.user_id', true) = '');
