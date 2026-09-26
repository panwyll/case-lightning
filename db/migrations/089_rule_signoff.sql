-- A firm signs off each rule the engine runs by. One row per rule per firm; deleting the row withdraws it.
create table if not exists rule_signoff (
  tenant_id  uuid not null references tenant(id) on delete cascade,
  rule_id    text not null,
  signed_by  uuid references app_user(id),
  signed_at  timestamptz not null default now(),
  primary key (tenant_id, rule_id)
);
