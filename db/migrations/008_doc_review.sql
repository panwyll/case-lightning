-- Document review: an AI read of a document (an email attachment or a saved matter
-- file), checked against what the matter already knows. The structured result lives
-- in `review` jsonb; this table is the audit/history trail. Tenant- and
-- matter-scoped like everything else.

create table if not exists document_review (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id),
  matter_id uuid not null references matter(id),
  document_id uuid references document(id),
  graph_message_id text,
  graph_attachment_id text,
  file_name text not null,
  mime_type text,
  review jsonb not null default '{}',
  model text,
  created_by uuid references app_user(id),
  created_at timestamptz not null default now()
);

create index if not exists document_review_matter_idx on document_review (matter_id, created_at desc);
