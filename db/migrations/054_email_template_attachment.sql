-- 054: an email template can carry a document. When the template is used (a workflow EMAIL
-- node fires), the referenced doc_template is generated from the matter and attached to the
-- email. Configured on the template itself (Email templates tab), so the attachment travels
-- with the template wherever it's used. Guarded/idempotent.
alter table template add column if not exists attach_doc_template_id uuid references doc_template(id) on delete set null;
