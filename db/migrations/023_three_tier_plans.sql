-- Move from the two-plan model (standard/team) to three tiers:
--   plus       — entry (replaces 'standard')
--   pro        — premium AI/automation, single seat, heavy-LLM usage-capped (new)
--   enterprise — premium + team/multi-seat (replaces 'team')
-- Pre-launch there may be no rows to remap; these are defensive.

update billing_account set plan = 'enterprise' where plan = 'team';
update billing_account set plan = 'plus'       where plan = 'standard';

-- Analytics MRR reference (internal dashboard only). Remap the two existing rows
-- and add 'pro'. Amounts here feed the MRR view, not billing — set real figures
-- once the Stripe prices are finalised.
update plan_price set plan = 'enterprise' where plan = 'team';
update plan_price set plan = 'plus'       where plan = 'standard';
insert into plan_price (plan, mrr_pennies) values ('pro', 35000)
  on conflict (plan) do nothing;
