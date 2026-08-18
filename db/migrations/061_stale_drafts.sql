-- Detect when a drafted reply has been overtaken by events.
--
-- CONVEYi drafts a reply, then twenty minutes later the other side's solicitor
-- emails the completion date, or searches land. The draft sitting in Outlook is now
-- wrong, and nothing said so — the fee earner sends a reply written against a case
-- that has since moved.
--
-- body_hash is what makes this safe. It records the draft exactly as WE wrote it, so
-- we can tell whether the human has since edited it. An edited draft is never
-- touched or regenerated: overwriting someone's own words is the one behaviour that
-- would get the product thrown out of a firm. We only ever flag.
alter table worklist_item add column if not exists body_hash text;
alter table worklist_item add column if not exists stale_since timestamptz;
alter table worklist_item add column if not exists stale_reason text;

-- "Open drafts on this matter" is the lookup every inbound email now performs.
create index if not exists worklist_item_matter_open_idx
  on worklist_item (tenant_id, matter_id) where done_at is null;

comment on column worklist_item.body_hash is
  'SHA-256 of the draft body as CONVEYi wrote it. Differs from the live draft = the user edited it, so never regenerate — flag only.';
comment on column worklist_item.stale_since is
  'Set when case information arrived after the draft was written. Cleared when regenerated or dismissed.';
