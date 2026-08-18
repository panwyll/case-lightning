-- "Awaiting from others" — the other half of a status update.
--
-- matter_summary.outstanding is deliberately only the FIRM's own next actions;
-- fact extraction was told to throw away anything we're merely waiting on another
-- party to do. But "waiting on the other side's replies to enquiries" is the single
-- most useful line in a status update to a client. Capture it in its own column so
-- a status draft can say what we're doing AND what we're waiting on.
--
-- Populated going forward as mail flows (see extractFacts); existing matters stay
-- null until their next fact extraction, which is fine — no backfill.
alter table matter_summary add column if not exists awaiting jsonb not null default '[]'::jsonb;

comment on column matter_summary.awaiting is
  'Items the firm is waiting on OTHER parties for (other side, client, lender, agent). The counterpart to outstanding (the firm''s own actions). See extractFacts.';
