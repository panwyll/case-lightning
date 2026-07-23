-- 053: new-firm onboarding + real team invites.
--
-- Firm onboarding: a resumable, admin-driven "get started" checklist. onboarding_state holds
-- per-step flags the user sets explicitly (e.g. acknowledging a step or skipping team invites);
-- most step completion is derived from real signals (has a workflow, has templates, has a matter…).
alter table tenant add column if not exists onboarded_at timestamptz;
alter table tenant add column if not exists onboarding_state jsonb not null default '{}'::jsonb;

-- Token-based team invites. A colleague is emailed a link; when they sign in with a matching
-- address in the firm's Microsoft tenant they inherit the invited role and the invite is accepted.
create table if not exists team_invite (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id) on delete cascade,
  email text not null,
  role text not null default 'CONVEYANCER',
  token text not null unique,
  status text not null default 'PENDING',            -- PENDING | ACCEPTED | REVOKED
  invited_by uuid references app_user(id),
  accepted_user_id uuid references app_user(id),
  created_at timestamptz not null default now(),
  accepted_at timestamptz
);
create index if not exists team_invite_tenant_idx on team_invite (tenant_id);
-- One live invite per address per firm.
create unique index if not exists team_invite_pending_email_idx
  on team_invite (tenant_id, lower(email)) where status = 'PENDING';
