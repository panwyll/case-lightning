-- Track when a matter entered its CURRENT stage, so the board's age dots show true
-- days-in-stage (not just last activity). New matters default to now(); existing ones
-- are seeded from their last update (best available baseline at migration time).
alter table matter add column if not exists stage_entered_at timestamptz not null default now();
update matter set stage_entered_at = coalesce(updated_at, created_at, now());
