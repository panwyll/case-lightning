-- Track the OneDrive file + document row a call note produces when assigned, so that
-- moving or un-assigning it can precisely clean those up (and its KB chunks) from the
-- wrong matter — no confidential residue left behind on a mis-assignment.
alter table call_note add column if not exists document_id  uuid;
alter table call_note add column if not exists drive_item_id text;
