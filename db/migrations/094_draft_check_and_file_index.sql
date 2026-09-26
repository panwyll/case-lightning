-- Document Review Engine, parts 6 and 7: the drafter on the register and the file index.
--
-- draft_check: for an engine-drafted document (a report on title), the check of every figure,
-- date and name in it against the fact register — which sentence rests on which facts, and what
-- is not from the file at all.
-- review_diff: when a document is read again (a new prompt version, a re-file), what changed in
-- its facts since the previous read.
alter table document add column if not exists draft_check jsonb;
alter table document add column if not exists review_diff jsonb;
comment on column document.draft_check is 'Engine draft check: sentences → fact ids, struck claims, cited facts (lib/server/engine/draft-check.ts).';
comment on column document.review_diff is 'What changed in the fact register the last time this document was re-read (added / removed / changed by key).';

-- Page text of every read document is indexed as kb_chunk rows of source_kind DOCUMENT_PAGE
-- (metadata: page, fileName, docType). The embedding is null when no embeddings key is set;
-- this index answers "where does the lease say X" by full-text search in that case.
create index if not exists kb_chunk_page_fts_idx on kb_chunk using gin (to_tsvector('english', chunk_text)) where source_kind = 'DOCUMENT_PAGE';
create index if not exists kb_chunk_page_source_idx on kb_chunk (source_id) where source_kind = 'DOCUMENT_PAGE';
