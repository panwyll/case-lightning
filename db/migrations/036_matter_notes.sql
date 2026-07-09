-- Free-text case notes shown as an editable box on the taskpane status card and the
-- admin matter drawer. A scratchpad for the fee-earner; distinct from the auto-derived
-- outstanding-items summary and from the timeline/audit log.
alter table matter add column if not exists notes text;
