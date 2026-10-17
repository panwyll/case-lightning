-- The Tasks list's Pending: an email someone filed is shown as processing until its reading is done, then as a task or
-- "No Action Required".
alter table mail_filing_claim add column if not exists filed_by uuid null;
alter table mail_filing_claim add column if not exists subject text null;
alter table mail_filing_claim add column if not exists finished_at timestamptz null;
create index if not exists mail_filing_claim_by_idx on mail_filing_claim (filed_by, claimed_at);
