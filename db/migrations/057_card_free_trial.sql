-- Card-free trial.
--
-- Until now the only way to become `entitled` was a Stripe subscription, which meant
-- handing over a card before seeing the product work on your own mailbox. For a cold
-- audience that's a hard ask, so a firm now gets a trial from the moment it first signs
-- in, with no payment details.
--
-- The column is an OVERRIDE, not the source of truth: when it's null the trial runs from
-- tenant.created_at for config.trialDays. That means no backfill is needed and no tenant
-- can accidentally lose its trial by having been created before this migration. Set it
-- explicitly only to extend (or cut short) a particular firm's trial.
alter table tenant add column if not exists trial_ends_at timestamptz;

comment on column tenant.trial_ends_at is
  'Optional override for the end of the card-free trial. Null = created_at + TRIAL_DAYS. See getTenantBilling in lib/server/plan.ts.';
