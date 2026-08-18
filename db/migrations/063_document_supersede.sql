-- Version supersession for matter documents.
--
-- Files dedupe by content hash, so a CHANGED file (same name, new bytes) correctly
-- becomes a new document row and new index chunks. But the old row and its chunks
-- lingered: the drafter could retrieve a figure from a superseded version with
-- nothing marking it stale — a confidently wrong "completion is £X" from last
-- week's draft contract. When a new version lands we now mark the prior rows
-- superseded and delete their index chunks, so retrieval only ever sees current.
alter table document add column if not exists superseded_at timestamptz;
alter table document add column if not exists superseded_by uuid references document(id);

-- "Current documents on this matter" — the common read once supersession exists.
create index if not exists document_current_idx
  on document (tenant_id, matter_id) where superseded_at is null;

comment on column document.superseded_at is
  'Set when a newer version of the same filename was filed on this matter. The row is kept for history; its kb_chunks are deleted so retrieval only surfaces the current version.';
