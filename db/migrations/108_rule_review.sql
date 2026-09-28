-- 108: per-rule review of the playbook. Each row is one review of one rule as its words stood
-- (rule_hash): approved, or a change proposed in the firm's words. The latest row per rule wins;
-- a rule whose words change after approval shows as changed until reviewed again. A proposal
-- changes no behaviour: it is exported for a developer to build from.
create table if not exists rule_review (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id) on delete cascade,
  rule_id text not null,
  rule_hash text not null,
  status text not null check (status in ('approved', 'change_proposed')),
  proposal text,
  reviewed_by uuid references app_user(id) on delete set null,
  reviewed_at timestamptz not null default now()
);
create index if not exists rule_review_latest on rule_review (tenant_id, rule_id, reviewed_at desc);
alter table rule_review enable row level security;
drop policy if exists rule_review_wall on rule_review;
create policy rule_review_wall on rule_review for all to public
  using (tenant_id = (select tenant_id from app_user where id::text = current_setting('app.user_id', true)) or current_setting('app.user_id', true) is null or current_setting('app.user_id', true) = '')
  with check (tenant_id = (select tenant_id from app_user where id::text = current_setting('app.user_id', true)) or current_setting('app.user_id', true) is null or current_setting('app.user_id', true) = '');
-- The whole-rulebook sign-off table from 106 is no longer used; drop it by hand if it holds nothing you need:
-- drop table if exists rulebook_signoff;
