-- Fix for 079: the person lookup in the critical-changes gate must see app_user.
--
-- 024 enabled row-level security on every table with no policies, so the automation role
-- (conveyi_automation, NOBYPASSRLS) sees no rows in app_user. 079's gate looked the actor
-- up as the caller, so from an automation context every actor read as "not a person" —
-- which wrongly refused the one thing automation may write: a client's decision from a
-- call note a person approved (it cites that approval). Nothing that should be refused got
-- through; this only refused something that should not have been.
--
-- 071's human gate had the same lookup: from automation it refused with "not a human user"
-- before the role policy could. Still refused, but for the wrong reason; it now uses the
-- helper too. (135 extends the helper so an account whose access was removed is not a person.)
--
-- The lookup moves into a SECURITY DEFINER helper (runs as the table owner, sees the row).
-- The trigger itself stays SECURITY INVOKER, because it must still see whether the caller
-- is the automation role (inside a definer function current_user would be the owner).

create or replace function is_firm_person(p_actor text, p_tenant uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from app_user u where u.id::text = p_actor and u.tenant_id = p_tenant)
$$;
revoke all on function is_firm_person(text, uuid) from public;
grant execute on function is_firm_person(text, uuid) to conveyi_automation;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'conveyi_app') then execute 'grant execute on function is_firm_person(text, uuid) to conveyi_app'; end if;
  if exists (select 1 from pg_roles where rolname = 'app_rls') then execute 'grant execute on function is_firm_person(text, uuid) to app_rls'; end if;
end $$;

create or replace function matter_event_critical_gate() returns trigger language plpgsql as $$
declare cited boolean; bd_ok boolean;
begin
  if new.type in ('bank_details_verified','bank_details_verification_failed','contracts_exchanged','completion_confirmed','client_decision_recorded') then
    if not is_firm_person(new.actor, new.tenant_id) then
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

-- 071's gate, with the same lookup.
create or replace function matter_event_human_gate() returns trigger language plpgsql as $$
declare approver uuid; approval_event uuid; ok boolean;
begin
  if new.type not in ('funds_requested','payment_authorised','report_on_title_sent') then
    return new;
  end if;
  begin
    approver := (new.payload->>'approvedBy')::uuid;
  exception when others then
    approver := null;
  end;
  if approver is null then
    raise exception 'event % requires payload.approvedBy — a human user id (addendum 3 §1)', new.type using errcode = '23514';
  end if;
  ok := is_firm_person(approver::text, new.tenant_id);
  if not ok then
    raise exception 'event % approvedBy % is not a human user of this firm', new.type, approver using errcode = '23514';
  end if;
  if new.type = 'report_on_title_sent' then
    begin
      approval_event := (new.payload->>'approvedEventId')::uuid;
    exception when others then
      approval_event := null;
    end;
    if approval_event is null or not exists (
      select 1 from matter_event a
       where a.id = approval_event and a.matter_id = new.matter_id and a.tenant_id = new.tenant_id
         and a.type = 'report_on_title_approved' and a.actor = approver::text
    ) then
      raise exception 'report_on_title_sent must cite a report_on_title_approved event on this matter written by approvedBy %', approver using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
