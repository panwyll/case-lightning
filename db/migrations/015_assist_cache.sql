-- Precomputed taskpane "situation" results, keyed by Outlook message.
--
-- The Graph change-notification webhook computes the full assist (match +
-- classification + thread summary + drafted reply) on receipt and stores it
-- here as READY, so opening the email in the taskpane is instant. A cold open
-- (old mail, or before the webhook finished) writes a PARTIAL row with the fast
-- half and fills in the slow half in the background.
create table if not exists assist_cache (
  tenant_id uuid not null references tenant(id),
  graph_message_id text not null,
  status text not null default 'PARTIAL', -- PARTIAL | READY | ERROR
  result jsonb not null,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, graph_message_id)
);
