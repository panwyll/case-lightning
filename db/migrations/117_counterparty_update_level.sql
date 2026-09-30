-- Trust level for updates to the other side (their solicitor, the estate agent) at milestones:
-- searches back, mortgage offer in, ready to exchange. Default Propose: each one is a task to approve.
alter table engine_action_level drop constraint if exists engine_action_level_action_check;
alter table engine_action_level add constraint engine_action_level_action_check
  check (action ~ '^(acknowledgement|chase|client_update|search_order|auto_clear|enquiry_draft|email_no_reply|counterparty_update)(:[A-Za-z0-9_]{1,40})?$');
