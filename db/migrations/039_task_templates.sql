-- Stage-triggered task workflow (a DAG the admin builds in the UI). When a matter reaches a
-- checkpoint (stage), the templates for that stage are instantiated as matter_task rows and
-- assigned; a template with an unfinished prerequisite lands BLOCKED and unblocks when its
-- prerequisite task is marked done. All guarded/idempotent so a deploy before this migration
-- no-ops on the reads.

create table if not exists task_template (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id),
  stage text not null,                       -- checkpoint that creates it (INSTRUCTION, CONTRACT_PACK, …)
  detail text not null,                      -- the task text
  type text not null default 'TASK',
  assignee_kind text not null default 'ROLE', -- ROLE | USER
  assignee_role text,                        -- when ROLE: OWNER | CONVEYANCER | ASSISTANT | ADMIN
  assignee_user_id uuid references app_user(id),
  due_offset_days int,                        -- optional: due N days after the task is created
  pos_x double precision not null default 0,  -- canvas position (visual editor)
  pos_y double precision not null default 0,
  sort_order int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists task_template_tenant_idx on task_template(tenant_id, stage, sort_order);

-- DAG edges: from = prerequisite, to = dependent. The dependent stays BLOCKED until the
-- prerequisite's instantiated task is DONE.
create table if not exists task_template_edge (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id),
  from_template_id uuid not null references task_template(id) on delete cascade,
  to_template_id uuid not null references task_template(id) on delete cascade,
  unique (from_template_id, to_template_id)
);

-- Link an instantiated task back to the template it came from — powers dedup (don't recreate)
-- and unblocking (find dependents to open when a prerequisite completes).
alter table matter_task add column if not exists template_id uuid references task_template(id);
create index if not exists matter_task_template_idx on matter_task(matter_id, template_id);
