-- Counterparty / participant address book per matter.
--
-- Some incoming emails prompt an outbound action to a DIFFERENT party than the
-- sender (e.g. "tell the client the searches are back"), so we can't rely on a
-- straight reply-to. We harvest every address we see on a matter's email traffic
-- (from/to/cc) and let the fee earner tag each one's role, so the assistant can
-- later address the right person.

create table if not exists matter_contact (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null,
  matter_id    uuid not null references matter(id) on delete cascade,
  email        text not null,
  name         text,
  -- CLIENT | OTHER_SIDE | AGENT | LENDER | OUR_FIRM | OTHER | UNKNOWN
  role         text not null default 'UNKNOWN',
  -- how we learned it: EMAIL_FROM | EMAIL_TO | EMAIL_CC | MANUAL
  source       text,
  last_seen_at timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  unique (matter_id, email)
);

create index if not exists matter_contact_matter_idx on matter_contact (matter_id);
