-- The canonical taskpane worklist. Two buckets surface on the no-email landing:
--   * "To chase"      — derived live from email_thread (chase columns, migration 033); NOT stored here.
--   * "Ready to send"  — DRAFT_READY rows below: a reply OR a doc-received acknowledgement that
--                        CONVEYi has drafted into Outlook Drafts and is waiting for the user to send.
--
-- These are event-sourced (created at the draft-creation hook) rather than derived, because a draft
-- sitting in the Drafts folder isn't otherwise visible to us. Source-agnostic on purpose: a reply
-- (from an email) and an acknowledgement (from a portal download / manual upload) are the same kind
-- of "you have something to send" item, so a portal download is a first-class citizen — no inbound
-- email required.
create table if not exists worklist_item (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenant(id),
  matter_id      uuid not null references matter(id),
  kind           text not null,          -- 'DRAFT_READY' (room for more later)
  dedup_key      text not null,          -- thread id (reply) or graph_item_id / doc hash (ack) — idempotency
  title          text not null,          -- e.g. "Reply drafted" / "Update drafted: Searches received"
  detail         text,                   -- subject / document name
  thread_id      uuid,                   -- email_thread.id when it's a reply → auto-cleared when sent; null for acks
  graph_message_id text,                 -- draft id (or source message id)
  created_at     timestamptz not null default now(),
  snoozed_until  timestamptz,
  done_at        timestamptz,            -- set when sent (sweep) or dismissed by the user
  unique (tenant_id, kind, dedup_key)
);
create index if not exists worklist_item_open_idx on worklist_item (tenant_id) where done_at is null;
create index if not exists worklist_item_thread_idx on worklist_item (thread_id);
