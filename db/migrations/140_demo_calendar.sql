-- The demo host's Google Calendar, connected once (app/api/v1/demo/google): the account and its refresh token,
-- encrypted, so the booking page can ask Google which times are busy. Free/busy only; never what the events are.
-- One row. Read by us, never by a firm: row-level security on, no policies (024's rule).

create table if not exists demo_calendar (
  id                 int primary key default 1 check (id = 1),
  account            text not null,
  refresh_token_enc  text not null,
  connected_at       timestamptz not null default now()
);
alter table demo_calendar enable row level security;
