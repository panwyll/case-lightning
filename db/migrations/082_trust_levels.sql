-- Trust levels per engine action, replacing per-sub-flow shadow/assist/autonomous.
--
-- propose — the engine asks first: a proposal lands in Tasks and nothing happens until a
--           person approves it. Every firm starts here for every action.
-- assist  — acknowledgements, chases and search orders go out unasked; client updates
--           are still proposed; auto-clears happen and are confirmed afterwards.
-- auto    — everything proceeds. Flagged decisions and human-gated events stay a person's.
create table if not exists engine_action_level (
  tenant_id  uuid not null references tenant(id) on delete cascade,
  action     text not null check (action in ('acknowledgement','chase','client_update','search_order','auto_clear')),
  level      text not null default 'propose' check (level in ('propose','assist','auto')),
  updated_by uuid references app_user(id),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, action)
);
grant select on engine_action_level to conveyi_automation;

-- Shadow mode is gone: nothing is hidden or suppressed any more. The event types stay in
-- old logs and still replay; the switch and the per-sub-flow table go.
drop table if exists engine_subflow_status;
update matter set shadow_mode = false where shadow_mode;
