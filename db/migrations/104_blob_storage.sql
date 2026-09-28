-- File contents move out of the database into Supabase Storage (bucket case-documents).
-- document_blob stays as the index of what we hold: the bytes column empties as files move,
-- storage_path says where each one now lives.
alter table document_blob alter column bytes drop not null;
alter table document_blob add column if not exists storage_path text;
alter table document_blob add column if not exists size_bytes integer;
