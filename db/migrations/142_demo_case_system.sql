-- Which case management system a firm booking a demo runs (app/conveyi/demo): tells us which integration to build
-- next, and whether the demo is an InTouch one.

alter table demo_booking add column if not exists case_system text;
