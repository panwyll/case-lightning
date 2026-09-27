-- Scenario library: sandbox matters. A sandbox matter is a real matter row driven by a
-- scripted scenario through the real engine, so a firm can walk every path of the flowchart
-- on its own data model without touching a client's case. It is quarantined: no document
-- reading by Claude (fixture facts only), no search or ID orders, no emails or chases sent,
-- no LEAP / InTouch write-back, no billing, no email matching, and deletable in one click.
alter table matter add column if not exists sandbox boolean not null default false;
alter table matter add column if not exists sandbox_scenario text;
alter table matter add column if not exists sandbox_step text;
comment on column matter.sandbox is 'A scenario-library case (lib/server/engine/sandbox.ts): quarantined from every outward effect; never a client matter.';
create index if not exists matter_sandbox_idx on matter (tenant_id) where sandbox;
