-- Per-email journey: for every triaged email, the full labelling decision next to
-- what the fee earner actually did with it. Answers "how was this email labelled,
-- and what action did the user take?" in one row.
--
-- Built entirely from the audit log (jsonb payloads), so it needs no schema change:
--   • EMAIL_TRIAGED      — the label (enriched in lib/server/triage.ts): intent,
--                          urgency, needs-attention, recommended move, RAG status
--                          tag, matter match band/ref.
--   • USER_ACTION_CHOSEN — the move the user picked (app/api/v1/triage/action).
--   • the granular per-email actions (draft, save, extract, review) for the trail.
--
-- Additive (a view only) — safe to run in the Supabase SQL editor on prod.

create or replace view v_email_journey as
with labelled as (
  -- Latest label per message (re-triage overwrites the picture).
  select distinct on (payload->>'messageId')
    tenant_id,
    matter_id,
    payload->>'messageId'              as message_id,
    payload->>'conversationId'         as conversation_id,
    payload->>'matterRef'              as matter_ref,
    payload->>'intent'                 as intent,
    payload->>'urgency'                as urgency,
    (payload->>'needsAttention')::boolean as needs_attention,
    payload->>'recommendedAction'      as recommended_action,
    payload->>'statusTag'              as status_tag,
    payload->>'band'                   as match_band,
    (payload->>'confidence')::numeric  as confidence,
    created_at                         as labelled_at
  from audit_log
  where action_type = 'EMAIL_TRIAGED' and payload ? 'messageId'
  order by payload->>'messageId', created_at desc
),
chosen as (
  -- Latest explicit move the user picked for the message.
  select distinct on (payload->>'messageId')
    payload->>'messageId' as message_id,
    payload->>'action'    as user_action,
    actor_user_id         as actioned_by,
    created_at            as actioned_at
  from audit_log
  where action_type = 'USER_ACTION_CHOSEN' and payload ? 'messageId'
  order by payload->>'messageId', created_at desc
),
acts as (
  -- Granular follow-on actions, keyed by message id or (falling back to) thread id.
  select
    tenant_id,
    coalesce(payload->>'messageId', payload->>'graphThreadId') as key,
    action_type,
    created_at
  from audit_log
  where action_type in (
    'DRAFT_GENERATED', 'OUTLOOK_DRAFT_CREATED', 'FACTS_EXTRACTED',
    'EMAIL_SAVED_TO_MATTER', 'DOCUMENT_REVIEWED'
  )
)
select
  l.tenant_id,
  l.matter_id,
  l.matter_ref,
  l.message_id,
  l.conversation_id,
  l.intent,
  l.urgency,
  l.needs_attention,
  l.recommended_action,
  l.status_tag,
  l.match_band,
  l.confidence,
  l.labelled_at,
  c.user_action,
  c.actioned_by,
  c.actioned_at,
  -- Did the user follow the system's recommended move?
  case
    when c.user_action is not null and l.recommended_action is not null
      then lower(c.user_action) = lower(l.recommended_action)
  end as followed_recommendation,
  -- Everything else that happened on this email/thread, in order.
  (
    select array_agg(distinct a.action_type)
    from acts a
    where a.tenant_id = l.tenant_id
      and (a.key = l.message_id or a.key = l.conversation_id)
  ) as downstream_actions
from labelled l
left join chosen c on c.message_id = l.message_id
order by l.labelled_at desc;
