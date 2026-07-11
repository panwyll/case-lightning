-- Who we're chasing, captured by the chase sweep from the last outbound message's
-- primary recipient — so the worklist can say "Chase <name> — <subject>" instead of a
-- bare "Chase reply". Nullable; back-filled on the next sweep. Guarded/idempotent.
alter table email_thread add column if not exists chase_to_name text;
