-- Workload baseline (docs/workload-baseline.md): what a conveyancer's own mailbox says about
-- where their week goes, and how much of it does not need a conveyancer.
--
-- A scan reads Sent Items and the Inbox over a window, classifies each message, and keeps one
-- row per message with NO text: direction, timings, words written, recipients' roles, the
-- category and how it was decided. The conveyancer checks a random sample against Outlook; the
-- report corrects its counts by what the sample found. Driven in slices like onboarding_job.

create table if not exists workload_scan (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenant(id),
  user_id         uuid not null references app_user(id),
  -- SCANNING_SENT -> SCANNING_INBOX -> CLASSIFYING -> CHECKING -> COMPLETE (or FAILED / CANCELLED)
  status          text not null default 'SCANNING_SENT',
  since           timestamptz not null,
  until           timestamptz not null,
  cursor          text null,                 -- Graph @odata.nextLink for the folder being read
  max_messages    int not null default 5000,
  messages_read   int not null default 0,
  classified      int not null default 0,
  model           text null,
  prompt_version  text null,
  error           text null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  completed_at    timestamptz null
);
create index if not exists workload_scan_user_idx on workload_scan (user_id, created_at desc);
create index if not exists workload_scan_tenant_idx on workload_scan (tenant_id, created_at desc);

create table if not exists workload_email (
  id                 uuid primary key default gen_random_uuid(),
  scan_id            uuid not null references workload_scan(id) on delete cascade,
  tenant_id          uuid not null references tenant(id),
  user_id            uuid not null references app_user(id),
  graph_message_id   text not null,
  conversation_id    text null,
  direction          text not null check (direction in ('out', 'in')),
  drafted_at         timestamptz null,       -- Graph createdDateTime: when the draft was started
  sent_at            timestamptz not null,   -- sentDateTime (out) / receivedDateTime (in)
  words_written      int not null default 0, -- the part this message added, without the signature
  recipient_roles    text[] not null default '{}',
  is_reply           boolean not null default false,
  is_forward         boolean not null default false,
  has_attachments    boolean not null default false,
  -- Filtered by rule before classifying (automated, bulk, calendar, empty); null when classified.
  filtered           text null,
  category           text null,
  confidence         numeric(4,3) null,
  classified_by      text null check (classified_by in ('rule', 'model')),
  -- The conveyancer's check of a random sample: agreed, or the right category.
  in_sample          boolean not null default false,
  checked_category   text null,
  checked_at         timestamptz null,
  created_at         timestamptz not null default now(),
  unique (scan_id, graph_message_id)
);
create index if not exists workload_email_scan_idx on workload_email (scan_id, direction, category);
create index if not exists workload_email_sample_idx on workload_email (scan_id) where in_sample;

-- The conveyancer's own estimate of the minutes spent finding what to say, per category.
create table if not exists workload_estimate (
  tenant_id   uuid not null references tenant(id),
  user_id     uuid not null references app_user(id),
  category    text not null,
  minutes     numeric(5,1) not null check (minutes >= 0 and minutes <= 240),
  updated_at  timestamptz not null default now(),
  primary key (user_id, category)
);

-- The firm's figures the report turns hours into money with (hours_per_case is already here).
alter table firm_baseline add column if not exists fee_per_completion_pennies bigint null;
alter table firm_baseline add column if not exists pay_per_completion_pennies bigint null;
alter table firm_baseline add column if not exists contracted_hours numeric(4,1) null;   -- default 37.5
alter table firm_baseline add column if not exists typing_wpm int null;                  -- default 40
alter table firm_baseline add column if not exists workday_start text null;              -- 'HH:MM', default 09:00
alter table firm_baseline add column if not exists workday_end text null;                -- default 17:30

alter table workload_scan enable row level security;
alter table workload_email enable row level security;
alter table workload_estimate enable row level security;
drop policy if exists workload_scan_all on workload_scan;
create policy workload_scan_all on workload_scan for all to public using (true) with check (true);
drop policy if exists workload_email_all on workload_email;
create policy workload_email_all on workload_email for all to public using (true) with check (true);
drop policy if exists workload_estimate_all on workload_estimate;
create policy workload_estimate_all on workload_estimate for all to public using (true) with check (true);

comment on table workload_scan is 'A scan of one conveyancer''s mailbox for the workload baseline (docs/workload-baseline.md).';
comment on table workload_email is 'One row per scanned message: timings, words written, category. No message text is stored.';
comment on table workload_estimate is 'A conveyancer''s own minutes per email category spent finding what to say.';
