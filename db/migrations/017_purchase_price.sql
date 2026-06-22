-- Purchase price as a first-class, editable matter field. Stored as free text
-- (e.g. "£246,000") rather than a numeric: it's entered/edited by hand and read
-- back verbatim, never computed on. Additive — safe to run in the Supabase SQL
-- editor on prod.
alter table matter add column if not exists purchase_price text;
