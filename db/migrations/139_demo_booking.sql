-- A demo booked straight into the calendar (Calendly) rather than asked for (138): the booking's own links, and
-- no name or firm of ours to hold (the calendar has them). Where the visitor came from is kept the same way.

alter table demo_request alter column name drop not null;
alter table demo_request alter column email drop not null;
alter table demo_request alter column firm drop not null;
alter table demo_request add column if not exists booking_event_uri text;
alter table demo_request add column if not exists booking_invitee_uri text;
