-- Firm-customisable task statuses. Each status has a `kind` (OPEN | IN_PROGRESS | DONE) that
-- drives all logic (worklist filtering, DAG unblock), while `name` is the firm's own label shown
-- in the UI. matter_task keeps its canonical `status` (= the kind) for queries and gains a
-- `status_label` for the custom name. Guarded/idempotent.
create table if not exists task_status (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id),
  name text not null,                         -- display label, stored on matter_task.status_label
  kind text not null default 'OPEN',          -- OPEN | IN_PROGRESS | DONE (canonical logic value)
  color text,
  sort_order int not null default 0,
  active boolean not null default true,
  unique (tenant_id, name)
);
create index if not exists task_status_tenant_idx on task_status(tenant_id, sort_order);

alter table matter_task add column if not exists status_label text;
alter table tenant add column if not exists statuses_seeded boolean not null default false;
