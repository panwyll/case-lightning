-- The onboarding measurement (docs/epa-categories.md, "The measurement phase"): what a scan read from InTouch
-- for the person's own cases over the scan's window. Counts only: live cases, cases opened, and what was filed
-- (email records, notes, call records, documents), split by who filed it. Nothing is downloaded or stored.
alter table workload_scan add column if not exists intouch jsonb null;
-- Two months of a busy conveyancer's mailbox is more than the old default cap.
alter table workload_scan alter column max_messages set default 15000;
comment on column workload_scan.intouch is 'What the scan read from InTouch: counts for the person''s cases in the window (docs/epa-categories.md).';
