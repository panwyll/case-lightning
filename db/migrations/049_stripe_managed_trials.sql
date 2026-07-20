-- Stripe-managed trials.
--
-- Before this, billing_account.status defaulted to 'trialing' and NOTHING could ever
-- expire it: there is no trial_end column, and status is only ever written by the
-- Stripe webhook (matched on stripe_customer_id). An account that never completed
-- checkout therefore had no customer id, so no webhook ever matched it, so it stayed
-- 'trialing' — permanently entitled, for free. isEntitled() allows active|trialing,
-- so the 402 box-out was unreachable for those accounts.
--
-- The fix is to let Stripe own the trial clock (subscription_data.trial_period_days
-- at checkout; the subscription webhook writes trialing → active → unpaid/canceled).
-- That only works if a plan-less, Stripe-less account is NOT entitled by default.
--
-- IMPORTANT: run the preview in step 0 first and eyeball the count. Step 2 revokes
-- access from every account that never subscribed — intended, but check the blast
-- radius before committing.

-- ── 0. Preview (run on its own first; changes nothing) ──────────────────────────
-- select id, email, plan, status, stripe_customer_id, created_at
--   from billing_account
--  where status = 'trialing' and stripe_customer_id is null
--  order by created_at;

-- ── 1. New accounts are not entitled until Stripe says so ──────────────────────
alter table billing_account alter column status set default 'none';

-- ── 2. Expire the perpetual trials ─────────────────────────────────────────────
-- Only rows that never reached Stripe. Anything with a stripe_customer_id is left
-- alone: its status is authoritative and owned by the webhook.
update billing_account
   set status = 'none', updated_at = now()
 where status = 'trialing'
   and stripe_customer_id is null;

-- ── 3. Comp the founder account ────────────────────────────────────────────────
-- comp_plan overrides Stripe entirely (see plan.ts getTenantBilling) and reports as
-- status 'active', trialing false — so this account shows "Firm", not "Trial", and a
-- webhook resync can never clobber it. Adjust the email if you signed in with another.
update billing_account
   set comp_plan = 'enterprise', updated_at = now()
 where lower(email) = lower('peteranwyll@hotmail.com');

-- ── 4. Verify ──────────────────────────────────────────────────────────────────
-- select email, plan, comp_plan, status from billing_account order by updated_at desc limit 20;
