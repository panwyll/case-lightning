-- Auto-triage becomes OPT-OUT: on by default for everyone, with a toggle to turn
-- it off. It only matches, tags and precomputes incoming mail (and runs the firm's
-- auto-rules, which default to draft-only) — it never sends a reply.
--
-- The renew cron and the taskpane's on-open self-heal both arm a Graph subscription
-- for every `auto_triage_enabled = true` user, so flipping this flag is enough to
-- enable on-receipt triage without any manual click.

-- 1) New users default to on.
alter table app_user alter column auto_triage_enabled set default true;

-- 2) Turn it on for existing users who never EXPLICITLY switched it off. Anyone
--    currently off who has an AUTO_TRIAGE_DISABLED audit deliberately opted out
--    (and hasn't since re-enabled, or they'd already be true) — leave them off.
update app_user u
   set auto_triage_enabled = true
 where u.auto_triage_enabled = false
   and not exists (
     select 1 from audit_log a
      where a.actor_user_id = u.id
        and a.action_type = 'AUTO_TRIAGE_DISABLED'
   );
