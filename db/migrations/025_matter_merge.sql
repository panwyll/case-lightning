-- Merge cases: when two matters were created for what is really one case, merge
-- the duplicate into the survivor. The merged-away matter is kept (not deleted)
-- with status='MERGED' and a pointer to the survivor, so history/audit stay intact
-- and its OneDrive folder is still reachable.
alter table matter add column if not exists merged_into uuid references matter(id);
create index if not exists matter_merged_into_idx on matter(merged_into);
