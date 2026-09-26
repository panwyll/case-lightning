-- Trust levels per subject: `chase:lender`, `search_order:CON29`, `client_update:exchanged`,
-- `auto_clear:title`. A subject row overrides its action's row. The key format replaces the
-- fixed list of five.
alter table engine_action_level drop constraint if exists engine_action_level_action_check;
alter table engine_action_level add constraint engine_action_level_action_check
  check (action ~ '^(acknowledgement|chase|client_update|search_order|auto_clear)(:[A-Za-z0-9_]{1,40})?$');
