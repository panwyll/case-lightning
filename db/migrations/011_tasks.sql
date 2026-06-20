-- "Jira in Excel": per-matter tasks.
--
-- Postgres is the source of truth — it's fast, queryable across matters, and
-- drives the taskpane board and assignment. But every task also mirrors to the
-- matter's Tracker.xlsx via a stable `ref` shared with the Excel row, so the
-- conveyancer can read AND edit it live in Excel (status, owner, due, detail)
-- and have those edits sync back. Excel stays a first-class surface, not a
-- read-only export — that's the whole "works inside the tools you already use"
-- promise.

create table if not exists matter_task (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id),
  matter_id uuid not null references matter(id) on delete cascade,
  -- Stable human key shared with the Excel "Ref" cell (e.g. T-0007). This is how
  -- a row edited by hand in Excel is reconciled back to its task.
  ref text not null,
  type text not null default 'TASK',        -- TASK | ENQUIRY | UPDATE | OUTSTANDING
  detail text not null default '',
  assignee text,                            -- name/email mirrored to the Excel "Owner" column
  assignee_user_id uuid references app_user(id),
  due date,
  status text not null default 'OPEN',      -- OPEN | IN_PROGRESS | DONE | NOTED
  source text not null default 'APP',       -- APP | ASSISTANT | EXCEL
  -- Last time we pushed/reconciled this task with the Excel row, for change
  -- detection during the two-way sync.
  excel_synced_at timestamptz,
  created_by uuid references app_user(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (matter_id, ref)
);

create index if not exists matter_task_matter_idx on matter_task (tenant_id, matter_id, status);
