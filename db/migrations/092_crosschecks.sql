-- Cross-checks: the same fact compared across documents and the case record, kept per matter
-- so the case page and the task box can show them; and a person's confirm / dispute on a fact.
create table if not exists matter_crosscheck (
  tenant_id  uuid not null references tenant(id) on delete cascade,
  matter_id  uuid not null references matter(id) on delete cascade,
  "check"    text not null,
  status     text not null,             -- match | mismatch | gap
  detail     jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, matter_id, "check")
);
alter table document_fact add column if not exists confirmed_by uuid references app_user(id);
alter table document_fact add column if not exists confirmed_at timestamptz;
alter table document_fact add column if not exists disputed_note text;
alter table matter_crosscheck enable row level security;
create policy automation_access on matter_crosscheck for all to public using (current_user = 'conveyi_automation') with check (current_user = 'conveyi_automation');
