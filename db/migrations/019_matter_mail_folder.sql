-- Per-matter Outlook Inbox subfolder.
--
-- Each matter gets its own Inbox subfolder (e.g. "Leaping Llama 14 Oak Street").
-- Processed emails for the matter are moved there to keep the inbox clear. We
-- store the Graph folder id (and the display name for reference/debug).

alter table matter add column if not exists mail_folder_id   text;
alter table matter add column if not exists mail_folder_name text;
