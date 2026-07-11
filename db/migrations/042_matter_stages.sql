-- Firm-customisable pipeline stages (checkpoints). `key` is the stable value stored on
-- matter.stage / task_template.stage (so renaming a stage's display `name` never orphans data
-- or breaks matching/milestone logic); `name` is the label shown in the board and dropdowns.
-- The 7 built-in keys are seeded so existing matters, milestones and matching keep working.
create table if not exists matter_stage (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id),
  key text not null,                 -- stable value (matter.stage, task_template.stage)
  name text not null,                -- display label
  sort_order int not null default 0,
  active boolean not null default true,
  unique (tenant_id, key)
);
create index if not exists matter_stage_tenant_idx on matter_stage(tenant_id, sort_order);

alter table tenant add column if not exists stages_seeded boolean not null default false;
