-- Who may see what, inside a firm.
--
-- case_access_mode on the firm: 'open' (any conveyancer opens any case, the default) or
-- 'granted' (a conveyancer sees the cases they handle plus what they have been granted).
-- Admins always see everything. Assistants only ever see what they are granted, in either
-- mode, and see mailboxes only by grant.
alter table policy_config add column if not exists case_access_mode text not null default 'open'
  check (case_access_mode in ('open', 'granted'));

create table if not exists access_grant (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenant(id) on delete cascade,
  grantee_user_id  uuid not null references app_user(id) on delete cascade,
  -- case: one matter. cover: every case subject_user handles, while the window is open.
  -- mailbox: subject_user's filing queue (read, file, set aside).
  kind             text not null check (kind in ('case', 'cover', 'mailbox')),
  matter_id        uuid references matter(id) on delete cascade,
  subject_user_id  uuid references app_user(id) on delete cascade,
  starts_at        timestamptz not null default now(),
  ends_at          timestamptz,
  granted_by       uuid references app_user(id),
  created_at       timestamptz not null default now(),
  check ((kind = 'case' and matter_id is not null) or (kind in ('cover', 'mailbox') and subject_user_id is not null))
);
create index if not exists access_grant_grantee_idx on access_grant (tenant_id, grantee_user_id);
create unique index if not exists access_grant_case_key on access_grant (tenant_id, grantee_user_id, matter_id) where kind = 'case';
create unique index if not exists access_grant_subject_key on access_grant (tenant_id, grantee_user_id, kind, subject_user_id) where kind in ('cover', 'mailbox');
grant select on access_grant to conveyi_automation;
