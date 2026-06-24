-- Pre-load the default workflows once per firm. The flag stops them re-seeding
-- after an admin deletes them on purpose.
alter table tenant add column if not exists playbooks_seeded boolean not null default false;
