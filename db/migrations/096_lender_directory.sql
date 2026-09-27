-- The firm's lender directory: each lender's Part 2 answers that change a rule in the engine
-- (lib/server/engine/lender-directory.ts). When a mortgage offer names a lender in the directory,
-- the matter records those requirements and the rules use them (lease term, search age, gifts).
create table if not exists lender_profile (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id) on delete cascade,
  lender_name text not null,
  min_unexpired_years integer,
  max_search_age_months integer,
  accepts_non_family_gift boolean,
  requires_ews1 boolean,
  note text,
  updated_by uuid,
  updated_at timestamptz not null default now()
);
create unique index if not exists lender_profile_tenant_name_idx on lender_profile (tenant_id, lower(lender_name));
comment on table lender_profile is 'Per-firm lender Part 2 requirements; matched to a mortgage offer by lender name and recorded on the matter as lender_requirements_recorded.';
