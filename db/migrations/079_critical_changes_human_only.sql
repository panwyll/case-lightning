-- Critical changes are a person's, and the database is what says so.
--
-- 071 made the money events (funds_requested, payment_authorised) and the report on
-- title going out impossible to write without a named human approver, and impossible
-- from an automation context at all. This extends the same enforcement to everything
-- else that changes where money goes, who a case's people are, or where a case stands.
-- A bug, a prompt-injected email, or a future code path that "forgets" cannot write any
-- of it: the insert is refused.
--
--   1. Human-only events. Bank details verified / failed, contracts exchanged,
--      completion confirmed and a client's decision must carry, as their actor, a person
--      in this firm. From an automation context the first four are refused outright; a
--      client decision is accepted only when it cites the note_actions_applied event a
--      person approved it in, written by that same person.
--   2. Money moves only to verified details. funds_requested and payment_authorised must
--      name bank details on this matter that were verified out of band (status verified,
--      with an accepted method).
--   3. Bank details are never verified by automation. The automation role can record new
--      details (they arrive unverified and stop payments until a person checks them), but
--      it cannot mark any as verified.
--   4. Contact details. The automation role can add a contact, but cannot delete one,
--      change an email, change a phone number on file, or change a role a person set.
--      The one exception is a system of record (LEAP, InTouch) updating a contact it
--      supplied itself, or adopting one first seen on email (which had no role or phone).

-- ── 1 + 2: the event gate ──
create or replace function matter_event_critical_gate() returns trigger language plpgsql as $$
declare human boolean; cited boolean; bd_ok boolean;
begin
  if new.type in ('bank_details_verified','bank_details_verification_failed','contracts_exchanged','completion_confirmed','client_decision_recorded') then
    select exists (select 1 from app_user u where u.id::text = new.actor and u.tenant_id = new.tenant_id) into human;
    if not human then
      raise exception 'event % can only be recorded by a person in this firm (actor % is not one) — migration 079', new.type, new.actor using errcode = '42501';
    end if;
    if current_user = 'conveyi_automation' then
      if new.type <> 'client_decision_recorded' then
        raise exception 'event % can never be written by automation — migration 079', new.type using errcode = '42501';
      end if;
      select exists (
        select 1 from matter_event a
         where a.id::text = new.payload->>'approvedEventId' and a.matter_id = new.matter_id and a.tenant_id = new.tenant_id
           and a.type = 'note_actions_applied' and a.actor = new.actor
      ) into cited;
      if not cited then
        raise exception 'a client decision from automation must cite the note approval (approvedEventId) by the same person — migration 079' using errcode = '42501';
      end if;
    end if;
  end if;

  if new.type in ('funds_requested','payment_authorised') then
    select exists (
      select 1 from payee_bank_details b
       where b.id = new.payload->>'bankDetailsId' and b.matter_id = new.matter_id and b.tenant_id = new.tenant_id
         and b.status = 'verified' and b.verification_method is not null and b.verified_by is not null
    ) into bd_ok;
    if not bd_ok then
      raise exception 'event % must name bank details on this matter verified out of band — migration 079', new.type using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
-- Named to fire after 071's matter_event_human_gate_trg (triggers fire in name order), so a
-- missing approver is still reported as that; this gate adds to it.
drop trigger if exists matter_event_critical_gate_trg on matter_event;
drop trigger if exists matter_event_money_and_people_gate_trg on matter_event;
create trigger matter_event_money_and_people_gate_trg before insert on matter_event
  for each row execute function matter_event_critical_gate();

-- ── 3: bank details are never verified by automation ──
create or replace function payee_bank_details_automation_guard() returns trigger language plpgsql as $$
begin
  if current_user <> 'conveyi_automation' then return new; end if;
  if tg_op = 'INSERT' and (new.status <> 'unverified' or new.verification_method is not null or new.verified_by is not null) then
    raise exception 'automation may record bank details only as unverified — migration 079' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and (
       (new.status = 'verified' and old.status is distinct from 'verified')
    or new.verification_method is distinct from old.verification_method
    or new.verified_by is distinct from old.verified_by
    or new.verified_at is distinct from old.verified_at) then
    raise exception 'automation may never verify bank details — migration 079' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists payee_bank_details_automation_guard_trg on payee_bank_details;
create trigger payee_bank_details_automation_guard_trg before insert or update on payee_bank_details
  for each row execute function payee_bank_details_automation_guard();

-- ── 4: contact details ──
create or replace function matter_contact_automation_guard() returns trigger language plpgsql as $$
declare own_record boolean;
begin
  if current_user <> 'conveyi_automation' then return coalesce(new, old); end if;
  if tg_op = 'DELETE' then
    raise exception 'automation may not delete a contact — migration 079' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    -- A new contact from email traffic starts with no role (UNKNOWN): seen, not trusted.
    -- Only a system of record may add one with a role.
    if coalesce(new.role, 'UNKNOWN') <> 'UNKNOWN' and coalesce(new.source, '') not in ('LEAP','INTOUCH') then
      raise exception 'automation may add a contact only without a role, unless it comes from LEAP or InTouch — migration 079' using errcode = '42501';
    end if;
    return new;
  end if;
  -- A system of record updating its own contact, or adopting one first seen on email.
  own_record := new.source in ('LEAP','INTOUCH') and (new.source = old.source or coalesce(old.source, '') like 'EMAIL%');
  if new.email is distinct from old.email or new.matter_id is distinct from old.matter_id or new.tenant_id is distinct from old.tenant_id then
    raise exception 'automation may not change a contact''s email or case — migration 079' using errcode = '42501';
  end if;
  if old.phone is not null and new.phone is distinct from old.phone and not own_record then
    raise exception 'automation may not change a phone number on file — migration 079' using errcode = '42501';
  end if;
  if new.role is distinct from old.role and old.role <> 'UNKNOWN' and not own_record then
    raise exception 'automation may not change a contact''s role — migration 079' using errcode = '42501';
  end if;
  if new.source is distinct from old.source and old.source is not null and not (old.source like 'EMAIL%' and new.source in ('LEAP','INTOUCH')) then
    raise exception 'automation may not change where a contact came from — migration 079' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists matter_contact_automation_guard_trg on matter_contact;
create trigger matter_contact_automation_guard_trg before insert or update or delete on matter_contact
  for each row execute function matter_contact_automation_guard();
