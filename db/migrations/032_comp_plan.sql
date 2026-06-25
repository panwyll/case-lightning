-- Comp override: grant a tenant a tier for free (test / pilot / internal accounts)
-- regardless of Stripe. getTenantBilling honours comp_plan ABOVE the Stripe-derived
-- plan/status, so a Stripe webhook resync can't clobber it. Null = no comp (normal
-- billing applies). Set to 'plus' | 'pro' | 'enterprise'.
alter table billing_account add column if not exists comp_plan text;
