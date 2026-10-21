-- A firm asking for a demo from the website (app/conveyi/demo, app/api/v1/demo-request): who, which firm, how to reach
-- them, and where they came from. Read by us, never by a firm: row-level security on, no policies (024's rule).

create table if not exists demo_request (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  email        text not null,
  firm         text not null,
  phone        text,
  fee_earners  text,
  note         text,
  source       jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);
create index if not exists demo_request_created_idx on demo_request (created_at desc);
alter table demo_request enable row level security;
