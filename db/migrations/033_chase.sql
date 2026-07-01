-- "Chase up" support. Triage answers "what does this INCOMING email need?"; chasing is
-- the mirror — an OUTBOUND thread that's gone quiet. A thread is a chase when it's matched
-- to an OPEN matter, the LATEST message in the conversation was sent BY the firm (a
-- self-address), and no reply has come within config.chaseSlaDays. It clears the moment a
-- reply lands (the latest message becomes inbound) or the user snoozes it.
--
-- The live source of truth for "who sent last" is Microsoft Graph (the conversation,
-- spanning Sent Items). A background SWEEP reads that and PERSISTS the verdict onto the
-- thread here, so the taskpane worklist reads cheap, stored state rather than calling
-- Graph per thread on every open:
--   chase_awaiting_since — when the unanswered outbound message went out (null = the
--                          last message was inbound, i.e. the ball is NOT with the firm).
--   chase_last_message_id — Graph id of that outbound message, so we can flag it.
--   chase_checked_at      — last time the sweep looked at this thread via Graph (throttle).
--   chase_flagged_at      — when we last stamped the follow-up flag + "Chase up" category;
--                           we only (re)flag when a NEWER outbound message has gone out.
--   chase_snoozed_until   — hide + don't re-flag this thread until this time.
alter table email_thread add column if not exists chase_awaiting_since  timestamptz;
alter table email_thread add column if not exists chase_last_message_id text;
alter table email_thread add column if not exists chase_checked_at      timestamptz;
alter table email_thread add column if not exists chase_flagged_at      timestamptz;
alter table email_thread add column if not exists chase_snoozed_until   timestamptz;
