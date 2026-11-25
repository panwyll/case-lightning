-- The free inbox scan (app/conveyi/scan, lib/server/lead-scan.ts): a prospect signs in with Microsoft, read-only
-- (Mail.Read), and their last four weeks of email are labelled to show where the week goes. No firm or user account
-- is made. The sign-in's access token is kept encrypted only while the scan runs and is wiped when it ends; there
-- is no refresh token, so nothing can be read after it expires. Per email only the label, its time and who it was
-- with (client, agent, lender ...) are kept: never its text, subject or addresses. Read by us, never by a firm:
-- row-level security on, no policies (024's rule).

create table if not exists lead_scan (
  id                uuid primary key default gen_random_uuid(),
  token_hash        text not null unique,
  email             text not null,
  name              text,
  ms_tenant_id      text,
  status            text not null default 'SCANNING_SENT' check (status in ('SCANNING_SENT', 'SCANNING_INBOX', 'COMPLETE', 'FAILED')),
  since             timestamptz not null,
  until             timestamptz not null,
  cursor            text,
  access_token_enc  text,
  token_expires_at  timestamptz,
  messages_read     int not null default 0,
  sent              int not null default 0,
  received          int not null default 0,
  set_aside         int not null default 0,
  classified        int not null default 0,
  result            jsonb,
  error             text,
  source            jsonb not null default '{}'::jsonb,
  ip                text,
  notified_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  completed_at      timestamptz
);
create index if not exists lead_scan_email_idx on lead_scan (lower(email), created_at desc);
create index if not exists lead_scan_created_idx on lead_scan (created_at desc);
alter table lead_scan enable row level security;

create table if not exists lead_scan_email (
  scan_id          uuid not null references lead_scan(id) on delete cascade,
  message_key      text not null,
  direction        text not null check (direction in ('out', 'in')),
  sent_at          timestamptz not null,
  drafted_at       timestamptz,
  conversation_id  text,
  category         text,
  roles            text[] not null default '{}',
  filtered         text,
  primary key (scan_id, message_key)
);
alter table lead_scan_email enable row level security;
