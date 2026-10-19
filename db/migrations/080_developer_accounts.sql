-- Developer accounts, for setting a firm up.
--
-- A developer is an admin account flagged as a developer: the same privileges as an admin,
-- no more. Kept apart from the firm's own people in three ways:
--   * it is labelled as a developer wherever people are listed, and never offered as a
--     handler or task assignee (it is not a fee earner);
--   * it does not count as the firm's admin: the firm must always keep an admin of its own;
--   * its access can be removed in one step, and removal takes effect at once (the session
--     check and every sign-in route refuse an account whose access was removed).
--
-- Developers usually have no account in the firm's Microsoft tenant, so they sign in by
-- emailed one-time link (075). entra_object_id is a placeholder for them.

alter table app_user add column if not exists is_developer boolean not null default false;
alter table app_user add column if not exists added_by uuid references app_user(id);
alter table app_user add column if not exists access_removed_at timestamptz;
alter table app_user add column if not exists access_removed_by uuid references app_user(id);

comment on column app_user.is_developer is 'Developer account added for setup: admin privileges, labelled, never a handler, removable (080).';
comment on column app_user.access_removed_at is 'Set when a person''s access is removed; sessions and sign-in refuse the account from then on (080).';

-- A developer account is always an admin account.
alter table app_user drop constraint if exists app_user_developer_is_admin;
alter table app_user add constraint app_user_developer_is_admin check (not is_developer or role = 'ADMIN');
