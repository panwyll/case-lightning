-- "X on behalf of Y": when an admin is viewing the app as a colleague, every audit row
-- written in that session names the admin as the acting user beside the colleague it was
-- recorded as. Null for an ordinary session.
alter table audit_log add column if not exists acting_user_id uuid references app_user(id);
