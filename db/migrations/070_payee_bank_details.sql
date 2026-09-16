-- Addendum 2: payment verification — bank-detail change hard-stop.
--
-- PayeeBankDetails is a versioned, insert-only read model of the engine's
-- bank_details_* events (the log is still the source of truth). Every set or change is
-- a NEW row; a trigger refuses any change to the detail columns in place, so the table
-- itself shows every value ever on file for a payee. Verification fields are the only
-- mutable columns and are written once, from bank_details_verified / _failed events.
-- The ethical wall (069) applies like every other confidential table.
create table if not exists payee_bank_details (
  id                   text primary key,                 -- engine bankDetailsId (bd-<uuid>)
  tenant_id            uuid not null references tenant(id),
  matter_id            uuid not null references matter(id) on delete cascade,
  payee_kind           text not null,                    -- seller_solicitor | firm_client_account | client | lender | estate_agent | other
  payee_ref            text,
  sort_code            text not null,
  account_number       text not null,
  account_name         text not null,
  firm_name            text,
  source_channel       text not null,                    -- email | portal | phone | letter | in_person | manual | provider
  source_document_id   uuid references document(id),
  supersedes_id        text references payee_bank_details(id),
  status               text not null default 'unverified', -- unverified | verified | failed | superseded
  recorded_by          text not null,
  recorded_event_id    uuid references matter_event(id),
  verified_at          timestamptz,
  verified_by          text,
  verification_method  text,                             -- phone_callback_known_number | lawyer_checker_match | in_person | video_call_known_contact
  verification_ref     text,
  created_at           timestamptz not null default now()
);
create index if not exists payee_bank_details_matter_idx on payee_bank_details (tenant_id, matter_id, payee_kind, created_at desc);

create or replace function payee_bank_details_immutable() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'payee_bank_details is append-only: rows are never deleted' using errcode = '42501';
  end if;
  if new.sort_code <> old.sort_code or new.account_number <> old.account_number or new.account_name <> old.account_name
     or new.payee_kind <> old.payee_kind or new.matter_id <> old.matter_id or new.recorded_by <> old.recorded_by
     or new.source_channel <> old.source_channel or coalesce(new.source_document_id::text,'') <> coalesce(old.source_document_id::text,'') then
    raise exception 'payee_bank_details is append-only: record a new row instead of changing these details' using errcode = '42501';
  end if;
  if old.verification_method is not null and (new.verification_method is distinct from old.verification_method or new.verified_by is distinct from old.verified_by) then
    raise exception 'a verification cannot be rewritten' using errcode = '42501';
  end if;
  if new.verification_method is not null and new.verification_method not in ('phone_callback_known_number','lawyer_checker_match','in_person','video_call_known_contact') then
    raise exception 'verification_method % is not an accepted out-of-band method', new.verification_method using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists payee_bank_details_immutable_trg on payee_bank_details;
create trigger payee_bank_details_immutable_trg before update or delete on payee_bank_details
  for each row execute function payee_bank_details_immutable();

alter table payee_bank_details enable row level security;
alter table payee_bank_details force row level security;
drop policy if exists engine_wall on payee_bank_details;
create policy engine_wall on payee_bank_details for all using (not engine_walled(matter_id)) with check (not engine_walled(matter_id));

comment on table payee_bank_details is 'Versioned payee bank details (addendum 2). Read model of bank_details_* engine events; append-only; every payment event references a verified row.';
