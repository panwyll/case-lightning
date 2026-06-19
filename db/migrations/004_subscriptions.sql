-- Microsoft Graph change-notification subscriptions for auto-triage on arrival.
-- Opt-in per user; clientState is a per-subscription secret verified on each
-- incoming notification.
create table if not exists graph_subscription (
  id text primary key,                 -- Graph subscription id
  tenant_id uuid not null references tenant(id),
  user_id uuid not null references app_user(id) on delete cascade,
  resource text not null,
  client_state text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists graph_subscription_user_idx on graph_subscription (user_id);
create index if not exists graph_subscription_expiry_idx on graph_subscription (expires_at);
