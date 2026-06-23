-- Self-healing auto-triage: persist the user's INTENT separately from the live
-- Graph subscription. The subscription row is transient (it expires, and the
-- renew cron may delete a dead one), so on its own it can't tell "never enabled"
-- apart from "enabled but lapsed". This flag survives subscription loss, so the
-- taskpane (on open) and the cron can re-arm a subscription the user still wants.
alter table app_user add column if not exists auto_triage_enabled boolean not null default false;

-- Backfill: anyone with a live subscription clearly opted in.
update app_user u
   set auto_triage_enabled = true
 where exists (select 1 from graph_subscription s where s.user_id = u.id);
