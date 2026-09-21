-- Retire the Excel tracker and the master matters workbook.
--
-- The per-matter Tracker.xlsx and the firm-wide "All matters" workbook are gone: tasks,
-- stage, status and the case log live in Postgres and are shown in the app (the matter
-- board, the worklist, the engine). OneDrive stays as the document store. Nothing here
-- touches the OneDrive folder columns (drive_id, folder_item_id, folder_path, folder_web_url,
-- drive_owner_user_id).
--
-- The workbook files themselves are left where they are in each user's OneDrive — they are
-- the firm's files; delete them by hand if wanted.

alter table matter drop column if exists tracker_item_id;
alter table matter drop column if exists tracker_web_url;
alter table matter drop column if exists board_synced_at;
alter table matter_task drop column if exists excel_synced_at;
alter table auto_rule drop column if exists do_append_tracker;

-- Automations that still carry the retired APPEND_TRACKER step lose that step (the runner
-- also skips it, so a recipe saved between deploy and migration is safe).
update automation
   set steps = coalesce((select jsonb_agg(s) from jsonb_array_elements(steps) s where s->>'type' <> 'APPEND_TRACKER'), '[]'::jsonb),
       updated_at = now()
 where steps @> '[{"type":"APPEND_TRACKER"}]'::jsonb;
