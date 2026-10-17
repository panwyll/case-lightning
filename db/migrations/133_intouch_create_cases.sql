-- A case opened in CONVEYi is created in the firm's InTouch too (lib/server/integrations/case-system.ts). InTouch
-- describes a matter by the firm's own "data markers": which marker takes each field is set per firm, and creating
-- stays off until the required ones are filled in.
alter table intouch_connection add column if not exists create_markers jsonb not null default '{}'::jsonb;
