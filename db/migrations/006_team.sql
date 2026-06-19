-- Team-readiness: matter ownership (real assignment).
alter table matter add column if not exists assigned_to uuid references app_user(id);
create index if not exists matter_assigned_idx on matter (tenant_id, assigned_to);
