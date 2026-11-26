-- The free case study (app/conveyi/case-study, lib/server/case-study.ts): a lead magnet in the shape $100M Leads opens
-- with, a video of one firm's result behind a short form. Each person who asks for it is a lead: name, work email,
-- firm, where they came from. Read by us, never by a firm: row-level security on, no policies (024's rule).
create table if not exists case_study_lead (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  email       text not null,
  firm        text,
  source      jsonb not null default '{}'::jsonb,
  ip          text,
  created_at  timestamptz not null default now()
);
create index if not exists case_study_lead_created_idx on case_study_lead (created_at desc);
create index if not exists case_study_lead_email_idx on case_study_lead (lower(email));
alter table case_study_lead enable row level security;
