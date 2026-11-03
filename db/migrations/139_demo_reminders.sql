-- Reminders for a booked demo (lib/server/demo/bookings.ts, sent by app/api/v1/cron/demo-reminders): the day
-- before and an hour before, each sent once. A demo booked less than a day ahead gets only the hour-before one.

alter table demo_booking add column if not exists reminded_day_at timestamptz;
alter table demo_booking add column if not exists reminded_hour_at timestamptz;
