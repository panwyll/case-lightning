-- Email steps in the workflow DAG. A node can be a TASK (as before) or an EMAIL that fires a
-- templated email when the matter reaches the stage (and its prerequisites are done). send_mode
-- DRAFT = draft into the ready-to-send queue (human sends); SEND = actually send (opt-in, only
-- when a recipient is known). Guarded/idempotent.
alter table task_template add column if not exists node_kind text not null default 'TASK'; -- TASK | EMAIL
alter table task_template add column if not exists email_template_id uuid references template(id);
alter table task_template add column if not exists send_mode text;                          -- DRAFT | SEND
