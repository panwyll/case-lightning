-- Read Only is no longer a role. Anyone still holding it becomes an assistant; the enum value stays (Postgres cannot drop one), unused.
update app_user set role = 'ASSISTANT' where role = 'READ_ONLY';
