-- 107: each person's own email signature, pasted as rendered HTML (like Gmail's signature box).
-- Stored cleaned (allowlisted tags and attributes only); empty = the firm's standard signature.
alter table app_user add column if not exists signature_html text;
