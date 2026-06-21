-- Two-way sync for the master matters board.
--
-- `board_synced_at` records when a matter's stage/status/assignee were last
-- written out to the master workbook. On the next sync we compare it with
-- `updated_at`: if the app changed the matter since (updated_at > board_synced_at)
-- the app value wins and is pushed out; otherwise a differing Excel cell is a
-- human edit and is pulled back in. Same conflict policy as the task tracker.

alter table matter add column if not exists board_synced_at timestamptz;
