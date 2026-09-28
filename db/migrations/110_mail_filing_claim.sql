-- One filing per email: whichever path gets to a message first (the new-mail notification, a
-- repeated notification, the inbox sweep) claims it; any other stops. Stops the same email being
-- filed twice at the same moment (two copies of its tasks, its body read twice).
create table if not exists mail_filing_claim (
  tenant_id uuid not null,
  graph_message_id text not null,
  matter_id uuid,
  claimed_at timestamptz not null default now(),
  primary key (tenant_id, graph_message_id)
);
