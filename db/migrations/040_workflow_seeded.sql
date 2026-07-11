-- One-time marker so the default conveyancing task workflow is seeded once per firm and
-- doesn't reappear if the admin deletes tasks on purpose. Guarded/idempotent.
alter table tenant add column if not exists workflow_seeded boolean not null default false;
