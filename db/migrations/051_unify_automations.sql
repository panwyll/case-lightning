-- Collapse playbooks + auto-rules into ONE concept: an "automation".
--
-- They were always the same shape — a named recipe of steps triggered by an email —
-- differing only in the trigger: an auto-rule fires automatically on a matching
-- incoming email; a playbook fires when a user clicks run. So one table with a
-- `trigger` of AUTO | MANUAL, ordered `steps`, and (for AUTO) the match conditions +
-- auto-send risk fields. A MANUAL automation is exactly what a playbook was.
--
-- Strategy: evolve the playbook table (it already has the richer steps model) into
-- `automation`, then fold every auto_rule into it as an AUTO automation whose steps
-- are synthesised from its old action toggles. The auto_rule table is left in place
-- (orphaned) rather than dropped — reversible, and prod drops are risky.

-- ── 1. Rename + widen the table ────────────────────────────────────────────────
alter table playbook rename to automation;
alter index if exists playbook_tenant_idx rename to automation_tenant_idx;

alter table automation add column if not exists trigger text not null default 'MANUAL'; -- MANUAL | AUTO
-- AUTO match conditions (unused for MANUAL):
alter table automation add column if not exists intents text[] not null default '{}';
alter table automation add column if not exists min_confidence real not null default 0.9;
alter table automation add column if not exists require_no_attention boolean not null default true;
alter table automation add column if not exists sender_domains text[] not null default '{}';
alter table automation add column if not exists match_stages text[] not null default '{}';
-- Auto-send risk acknowledgement (required + re-accepted whenever an AUTO automation has a sending step):
alter table automation add column if not exists risk_accepted boolean not null default false;
alter table automation add column if not exists risk_acknowledgement text;
alter table automation add column if not exists risk_accepted_by uuid references app_user(id);
alter table automation add column if not exists risk_accepted_at timestamptz;

-- ── 2. Fold auto_rule rows into automation as AUTO automations ──────────────────
-- Steps are synthesised from the old toggles, in the order they used to run:
-- categorise → append tracker → assign → reply (draft or send).
insert into automation
  (tenant_id, name, description, enabled, sort_order, trigger,
   intents, min_confidence, require_no_attention, sender_domains, match_stages,
   risk_accepted, risk_acknowledgement, risk_accepted_by, risk_accepted_at,
   steps, created_by, created_at, updated_at)
select
  r.tenant_id, r.name, null, r.enabled, 0, 'AUTO',
  r.intents, r.min_confidence, r.require_no_attention, r.sender_domains, coalesce(r.match_stages, '{}'),
  r.risk_accepted, r.risk_acknowledgement, r.risk_accepted_by, r.risk_accepted_at,
  (
    (case when r.do_categorize then jsonb_build_array(jsonb_build_object('type','TAG','config', jsonb_build_object('label', r.category_label))) else '[]'::jsonb end)
    || (case when r.do_append_tracker then jsonb_build_array(jsonb_build_object('type','APPEND_TRACKER','config', '{}'::jsonb)) else '[]'::jsonb end)
    || (case when r.do_assign then jsonb_build_array(jsonb_build_object('type','ASSIGN','config', jsonb_build_object('assigneeUserId', r.assign_to))) else '[]'::jsonb end)
    || (case when r.reply_mode in ('DRAFT','SEND') then jsonb_build_array(jsonb_build_object('type','DRAFT_REPLY','config', jsonb_build_object('templateId', r.reply_template_id, 'send', r.reply_mode = 'SEND'))) else '[]'::jsonb end)
  ),
  r.created_by, r.created_at, r.updated_at
from auto_rule r
-- idempotent: don't double-import if this migration is re-run
where not exists (
  select 1 from automation a where a.tenant_id = r.tenant_id and a.trigger = 'AUTO' and a.name = r.name
);

-- Index for the AUTO matcher (enabled AUTO automations, highest confidence first).
create index if not exists automation_auto_idx on automation (tenant_id, trigger, min_confidence desc) where enabled;
