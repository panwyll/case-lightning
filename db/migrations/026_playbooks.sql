-- Playbooks: named multi-step "custom actions" (e.g. "Onboard client") a firm
-- defines once and runs against an email in one go — create matter, draft reply,
-- create tasks, generate documents. Steps are an ordered jsonb array of
-- { type, config }. Indexed into kb_chunk so the assist can suggest the right one.
create table if not exists playbook (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id) on delete cascade,
  name        text not null,
  description text,
  steps       jsonb not null default '[]'::jsonb,
  enabled     boolean not null default true,
  sort_order  int not null default 0,
  created_by  uuid references app_user(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists playbook_tenant_idx on playbook(tenant_id, sort_order);
