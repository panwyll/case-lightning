-- 109: new rules the firm proposes for situations the playbook does not cover. A proposal changes
-- nothing; it is exported with the proposed changes for a developer to build from.
create table if not exists rule_proposal (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id) on delete cascade,
  signal text not null,
  sources text[] not null,
  senders text[] not null default '{}',
  example text,
  actions text not null,
  decides text not null,
  holds text not null default 'nothing',
  proposed_by uuid references app_user(id) on delete set null,
  proposed_at timestamptz not null default now(),
  withdrawn_at timestamptz
);
create index if not exists rule_proposal_tenant on rule_proposal (tenant_id, proposed_at desc);
alter table rule_proposal enable row level security;
drop policy if exists rule_proposal_wall on rule_proposal;
create policy rule_proposal_wall on rule_proposal for all to public
  using (tenant_id = (select tenant_id from app_user where id::text = current_setting('app.user_id', true)) or current_setting('app.user_id', true) is null or current_setting('app.user_id', true) = '')
  with check (tenant_id = (select tenant_id from app_user where id::text = current_setting('app.user_id', true)) or current_setting('app.user_id', true) is null or current_setting('app.user_id', true) = '');
