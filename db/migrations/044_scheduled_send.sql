-- Deferred outbound sends. Instead of firing an email the instant a human clicks
-- Send (or a workflow SEND node fires), we park the already-created Outlook draft
-- here with a scheduled_at ~20 min out. A worker (cron + opportunistic flush on
-- worklist load) sends anything due; the user can cancel inside the window.
create table if not exists scheduled_send (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenant(id) on delete cascade,
  matter_id        uuid references matter(id) on delete set null,
  user_id          uuid not null references app_user(id) on delete cascade,
  graph_message_id text not null,          -- the Outlook draft to send
  subject          text,
  recipient        text,
  source           text not null default 'MANUAL',   -- MANUAL | REPLY | WORKFLOW
  status           text not null default 'PENDING',  -- PENDING | SENT | CANCELLED | FAILED
  error            text,
  scheduled_at     timestamptz not null,
  sent_at          timestamptz,
  created_at       timestamptz not null default now()
);

create index if not exists scheduled_send_due_idx on scheduled_send (status, scheduled_at);
create index if not exists scheduled_send_tenant_idx on scheduled_send (tenant_id, status, scheduled_at);
