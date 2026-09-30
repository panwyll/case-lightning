-- Trust levels for the two newer actions: enquiries drafted from the seller's forms (enquiry_draft,
-- which 084's list predates, so its level could not be saved) and letting a pure acknowledgement
-- go without a reply (email_no_reply, default Propose: it still reaches a person as one click).
alter table engine_action_level drop constraint if exists engine_action_level_action_check;
alter table engine_action_level add constraint engine_action_level_action_check
  check (action ~ '^(acknowledgement|chase|client_update|search_order|auto_clear|enquiry_draft|email_no_reply)(:[A-Za-z0-9_]{1,40})?$');
