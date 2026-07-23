-- 052: document nodes in the workflow DAG.
-- A node's node_kind can now be 'DOC' — when the matter reaches its stage (and prerequisites
-- are done) it fills a doc_template into a real .docx and files it in the matter's Case files.
-- The same doc_template_id on an EMAIL node means "also attach this generated document to the
-- drafted/sent email" (e.g. generate the client care letter AND email it to the client).
-- node_kind is free text (no CHECK), so 'DOC' needs no constraint change. Guarded/idempotent.
alter table task_template add column if not exists doc_template_id uuid references doc_template(id) on delete set null;
