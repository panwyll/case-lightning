-- Correct the analytics MRR mapping for the Go / Pro / Firm ladder.
--
-- plan_price (009_analytics.sql) was seeded with 'standard' and 'team', which no plan
-- has been called since the rename. billing_account.plan stores 'plus' | 'pro' |
-- 'enterprise', so every join in v_revenue* missed and every subscription_event was
-- written with mrr_pennies = 0. Revenue analytics would have read zero no matter how
-- many firms paid.
--
-- Keys stay historical on purpose (see lib/server/plan.ts): plus = Go, pro = Pro,
-- enterprise = Firm. Prices as advertised on /conveyi/pricing and charged by Stripe.
insert into plan_price (plan, mrr_pennies) values
  ('plus',        20000),   -- Go   — £200/mo
  ('pro',         50000),   -- Pro  — £500/mo
  ('enterprise', 100000)    -- Firm — £1,000/mo
on conflict (plan) do update set mrr_pennies = excluded.mrr_pennies;

-- The old names are left in place rather than deleted: any historical row that
-- referenced them keeps resolving, and nothing new can be written with them.
