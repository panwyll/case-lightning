-- Whose OneDrive physically holds a matter's folder and tracker.
--
-- Every Graph drive call in the codebase is /me/drive, i.e. the CALLING user's own
-- OneDrive. So with several people on one case, the folder was created in whoever
-- made the matter, and a colleague filing a document created the same PATH in their
-- own drive: one case, files scattered across three personal drives, and
-- folder_web_url pointing at only one of them.
--
-- Recording an owner lets every drive operation for a matter run against that one
-- user's token, so the files stay in a single place. Deliberately NOT solved with
-- SharePoint: that needs Sites.ReadWrite.All, a scope we currently make a point of
-- not requesting, and this needs no new permission at all — just consistency about
-- whose delegated token performs the call.
--
-- Nullable: matters created before this fall back to the caller, exactly as before.
alter table matter add column if not exists drive_owner_user_id uuid references app_user(id);

comment on column matter.drive_owner_user_id is
  'The user whose OneDrive holds this matter''s folder/tracker. All drive operations for the matter run as this user — see driveUserFor in lib/server/matter-drive.ts. Null = legacy matter, falls back to the caller.';
