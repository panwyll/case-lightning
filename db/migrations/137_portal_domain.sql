-- A firm's own address for its clients' pages: portal.theirfirm.co.uk instead of ours (lib/server/portal-domain.ts).
-- The firm points the name at us with one DNS record; we add it to the hosting project, which issues the
-- certificate. Links go out on it only once it is live (portal_domain_live_at). Each address belongs to one firm.

alter table tenant add column if not exists portal_domain text;
alter table tenant add column if not exists portal_domain_live_at timestamptz;
alter table tenant drop constraint if exists tenant_portal_domain_host;
alter table tenant add constraint tenant_portal_domain_host check (portal_domain is null or portal_domain ~ '^([a-z0-9-]+\.)+[a-z]{2,63}$');
create unique index if not exists tenant_portal_domain_key on tenant (portal_domain) where portal_domain is not null;
