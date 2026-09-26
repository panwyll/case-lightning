-- Access is set on the person, not the case.
--   case_access    'all'      every case in the firm, including cases of people who join later
--                  'selected' their own cases plus the cases of the colleagues listed for them (access_grant kind 'cover')
--   mailbox_access 'own' | 'all' | 'selected' (access_grant kind 'mailbox')
alter table app_user add column if not exists case_access text not null default 'all' check (case_access in ('all', 'selected'));
alter table app_user add column if not exists mailbox_access text not null default 'own' check (mailbox_access in ('own', 'all', 'selected'));
update app_user set case_access = 'selected', mailbox_access = 'selected' where role = 'ASSISTANT';
-- A person created by an admin before they have signed in carries a placeholder object id;
-- their first Microsoft sign-in claims the row by email.
