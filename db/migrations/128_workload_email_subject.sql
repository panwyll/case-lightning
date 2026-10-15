-- See What It Read lists what the scan read from what it kept, without going back to the mailbox: the subject, and who
-- it was with as names and domains (no addresses). Older scans have neither; scanning again fills them.
alter table workload_email add column if not exists subject text null;
alter table workload_email add column if not exists who text null;
