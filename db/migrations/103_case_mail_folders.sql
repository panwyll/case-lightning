-- Each case's Inbox folder, per mailbox (every colleague who receives mail for the case gets
-- their own), and when it was moved into Archive (after completion).
create table if not exists matter_mail_folder (
  tenant_id uuid not null references tenant(id),
  matter_id uuid not null references matter(id),
  user_id uuid not null references app_user(id),
  folder_id text not null,
  folder_name text not null,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (matter_id, user_id)
);
