-- Reply times on Analytics → Cases: an email received and the next one sent on the same conversation.
alter table epa_action add column if not exists conversation_id text null;
create index if not exists epa_action_conversation_idx on epa_action (tenant_id, conversation_id, at);
