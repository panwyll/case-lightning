-- Read Again: one read of a document at a time (a second press while the first runs starts nothing).
alter table document add column if not exists read_again_at timestamptz;
