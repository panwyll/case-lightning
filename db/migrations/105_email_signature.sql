-- 105: a proper email signature. Graph sends do not pick up anyone's Outlook signature, so the
-- app signs every email itself: the person (name, job title, direct line) over the firm (name,
-- address, phone, website, SRA line), with the firm's logo and its standing notice (for example
-- "we will never change our bank details by email") when set.
alter table app_user add column if not exists job_title text;
alter table app_user add column if not exists phone text;
alter table tenant add column if not exists logo_url text;
alter table tenant add column if not exists signature_notice text;
