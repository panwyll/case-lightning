-- A demo booked from the website (app/conveyi/demo, lib/server/demo/bookings.ts): who, which firm, when, and where
-- they came from. The cancel link's secret is kept only as a hash. One booking per start time: two people picking
-- the same slot at once, the second is told it has gone. Read by us, never by a firm: row-level security on, no
-- policies (024's rule).

create table if not exists demo_booking (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null,
  email              text not null,
  firm               text not null,
  phone              text,
  fee_earners        text,
  note               text,
  starts_at          timestamptz not null,
  ends_at            timestamptz not null,
  status             text not null default 'booked' check (status in ('booked', 'cancelled')),
  cancel_token_hash  text not null unique,
  sequence           int not null default 0,
  source             jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  cancelled_at       timestamptz
);
create unique index if not exists demo_booking_slot_idx on demo_booking (starts_at) where status = 'booked';
create index if not exists demo_booking_email_idx on demo_booking (lower(email), created_at desc);
alter table demo_booking enable row level security;
