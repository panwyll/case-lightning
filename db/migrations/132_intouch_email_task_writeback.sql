-- InTouch write-back, two more things each off until the firm turns it on: the emails CONVEYi sends filed in the
-- InTouch case's correspondence, and steps done in CONVEYi completing the firm's matching InTouch tasks. `task_map` is
-- the firm's own mapping of each step to a task name ('none' = never), over the default reading of task names.
alter table intouch_connection add column if not exists emails_writeback boolean not null default false;
alter table intouch_connection add column if not exists tasks_writeback boolean not null default false;
alter table intouch_connection add column if not exists task_map jsonb not null default '{}'::jsonb;
