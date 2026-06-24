-- Content-addressed cache of document reviews. The same file on the same matter is
-- reviewed by Claude ONCE and shared across: ingest content-indexing, draft-time
-- attachment review, and reply regenerates — instead of re-paying the call each time.
--
-- Keyed by matter_id as well as the content hash because a review's consistency
-- checks are matter-relative (document vs that matter's facts). Entries are upserted
-- on re-review; lookups apply a TTL (see ai.ts) so reviews can't go stale against
-- changing matter facts indefinitely.
create table if not exists doc_review_cache (
  tenant_id   uuid        not null,
  matter_id   uuid        not null,
  content_hash text       not null,
  review      jsonb       not null,
  model       text,
  created_at  timestamptz not null default now(),
  primary key (tenant_id, matter_id, content_hash)
);
