-- 098: firm-level policy switches that are not trust levels or timers (the first: protect outgoing files).
create table if not exists tenant_policy (
  tenant_id  uuid not null references tenant(id) on delete cascade,
  key        text not null,
  value      jsonb not null,
  updated_by uuid references app_user(id),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, key)
);
alter table tenant_policy enable row level security;
drop policy if exists tenant_policy_wall on tenant_policy;
create policy tenant_policy_wall on tenant_policy for all to public
  using (tenant_id = (select tenant_id from app_user where id::text = current_setting('app.user_id', true)) or current_setting('app.user_id', true) is null or current_setting('app.user_id', true) = '')
  with check (tenant_id = (select tenant_id from app_user where id::text = current_setting('app.user_id', true)) or current_setting('app.user_id', true) is null or current_setting('app.user_id', true) = '');
grant select on tenant_policy to conveyi_automation;
