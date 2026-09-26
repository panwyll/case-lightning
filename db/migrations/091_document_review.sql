-- Document review: the coverage ledger (one row per page) and the fact register (one row per
-- extracted fact, verified by finding its quote in the page text). Both are projections of an
-- extraction run and are rewritten whenever the document is read again.
create table if not exists document_page (
  document_id  uuid not null references document(id) on delete cascade,
  tenant_id    uuid not null references tenant(id) on delete cascade,
  page         int  not null,
  verdict      text not null,            -- facts | nothing | unreadable | unattested
  text_chars   int  not null default 0,
  updated_at   timestamptz not null default now(),
  primary key (document_id, page)
);
create table if not exists document_fact (
  id           uuid primary key default gen_random_uuid(),
  document_id  uuid not null references document(id) on delete cascade,
  tenant_id    uuid not null references tenant(id) on delete cascade,
  matter_id    uuid not null references matter(id) on delete cascade,
  role         text not null,
  key          text not null,
  value        text not null,
  page         int,
  quote        text,
  confidence   numeric(4,3),
  verified     boolean not null default false,
  note         text,
  extractor    text,
  created_at   timestamptz not null default now()
);
create index if not exists document_fact_matter_idx on document_fact (tenant_id, matter_id, key);
create index if not exists document_fact_document_idx on document_fact (document_id);
alter table document_page enable row level security;
alter table document_fact enable row level security;
create policy automation_access on document_page for all to public using (current_user = 'conveyi_automation') with check (current_user = 'conveyi_automation');
create policy automation_access on document_fact for all to public using (current_user = 'conveyi_automation') with check (current_user = 'conveyi_automation');
