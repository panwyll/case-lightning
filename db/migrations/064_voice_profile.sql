-- Per-user writing-voice profile, learned from their own sent mail.
--
-- Drafts read as competent but generic — nobody's own voice. A conveyancer's
-- correspondence has a consistent register (salutation, sign-off, sentence length,
-- how formal, first-name vs surname), and a reply that matches it feels theirs and
-- needs less editing. Derived once from a sample of the user's Sent Items during the
-- initial scan, refreshable later. Per USER, not per tenant — the assistant, the
-- lawyer and the manager each write differently.
alter table app_user add column if not exists voice_profile jsonb;
alter table app_user add column if not exists voice_profile_at timestamptz;

comment on column app_user.voice_profile is
  'Compact writing-voice guide learned from the user''s own sent emails (see captureVoiceProfile). Steers drafting to match how they actually write; never overrides accuracy or professional standards.';
