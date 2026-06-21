-- Matter stage + status flag — drives the firm-wide "Jira in Excel" board.
--
-- `stage` tracks where the matter is in the UK conveyancing process (the board's
-- columns mirror the real workflow). `status_flag` is the at-a-glance health
-- signal a partner watches. `status` (from 001_init) stays as the open/closed
-- lifecycle.

alter table matter add column if not exists stage text not null default 'INSTRUCTION';
-- INSTRUCTION | CONTRACT_PACK | SEARCHES_ENQUIRIES | REVIEW_SIGNING | EXCHANGE | COMPLETION

alter table matter add column if not exists status_flag text not null default 'ON_TRACK';
-- ON_TRACK | NEEDS_ATTENTION | BLOCKED

create index if not exists matter_stage_idx on matter (tenant_id, stage, status_flag);
