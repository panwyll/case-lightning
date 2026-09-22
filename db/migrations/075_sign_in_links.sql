-- Passwordless sign-in (docs/sign-in.md).
--
-- CONVEYi no longer assumes a firm lives in Microsoft 365: a LEAP-only firm, a locum, or
-- anyone without a work Microsoft account signs in with a one-time link emailed to them.
--
-- Only the HASH of the token is stored — the link in the email is the only secret, and a
-- leaked database row cannot be replayed into a session. Rows are single-use (used_at),
-- short-lived (expires_at) and rate-limited per address by counting recent rows.
create table if not exists sign_in_link (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references app_user(id) on delete cascade,
  email       text not null,
  token_hash  text not null unique,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  -- Where the person was headed before they were asked to sign in.
  next_path   text,
  requested_ip text,
  created_at  timestamptz not null default now()
);

create index if not exists sign_in_link_email_idx on sign_in_link (lower(email), created_at desc);
create index if not exists sign_in_link_expiry_idx on sign_in_link (expires_at) where used_at is null;

-- The table is read and written only by the sign-in routes, which run before there is a
-- session to bind — so it stays outside row-level security, like the other pre-auth
-- tables, and is never exposed through a tenant-scoped query.

alter table sign_in_link enable row level security;
-- The sign-in routes run before any user is bound, exactly like the proof-of-funds form
-- route; the token hash is the only key into a row, so the policy is permissive and the
-- secrecy comes from the hash, not from the row filter.
drop policy if exists sign_in_link_all on sign_in_link;
create policy sign_in_link_all on sign_in_link for all to public using (true) with check (true);

grant select, insert, update on sign_in_link to conveyi_automation;
comment on table sign_in_link is 'One row per one-time sign-in link emailed to a user; token stored hashed, single-use, short-lived.';
