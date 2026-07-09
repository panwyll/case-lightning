-- Microsoft To Do spoke of the task sync (docs/two-way-sync-design.md).
-- Each matter task can mirror to a native To Do task in the ASSIGNEE's mailbox;
-- we remember its id + when we last confirmed a push, so the delta pull can apply
-- To Do edits back with the same last-write-wins guard the Excel spoke uses.
alter table matter_task add column if not exists todo_task_id text;   -- the todoTask id
alter table matter_task add column if not exists todo_user_id uuid;   -- whose To Do it lives in
alter table matter_task add column if not exists todo_synced_at timestamptz;

-- One CONVEYi To Do list per user (personal mailbox), plus the delta cursor for pulls.
alter table app_user add column if not exists todo_list_id text;
alter table app_user add column if not exists todo_delta_link text;
