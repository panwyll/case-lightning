/**
 * Triage = (deterministic match) + (LLM classification) + (audit record).
 * Auto-rules = the premium executor that acts on a triage result when the firm
 * has opted in. Both paths are fully audited and matter-isolated.
 */
import { query, queryOne } from './db';
import { matchMessage, messageSignals, type Candidate } from './matching';
import { classifyEmail, draftReply, retrieveMatterContext, type EmailIntent } from './ai';
import {
  createReplyDraft,
  createAndSendReply,
  appendTrackerRow,
  listThreadMessages,
  ensureMasterCategory,
  addMessageCategories,
} from './graph';
import { threadToText, stripHtml } from './text';
import { writeAudit } from './audit';
import { externalDomainsAllowed } from './guard';
import { isPremiumTenant } from './plan';
import type { SessionUser } from './types';

export interface Classification {
  intent: EmailIntent;
  needsAttention: boolean;
  urgency: 'LOW' | 'MEDIUM' | 'HIGH';
  reason: string;
}

export interface TriageResult {
  triageId: string;
  classification: Classification;
  candidates: Candidate[];
  top: Candidate | null;
  band: string;
}

/** Classify + match a message and persist a triage record. Pure read on Graph. */
export async function runTriage(user: SessionUser, message: any): Promise<TriageResult> {
  const signals = messageSignals(message);
  const candidates = await matchMessage(user.tenantId, signals);
  const top = candidates[0] ?? null;

  const emailText = [
    `Subject: ${message.subject ?? ''}`,
    `From: ${message.from?.emailAddress?.address ?? ''}`,
    '',
    stripHtml(message.body?.content) || (message.bodyPreview ?? ''),
  ].join('\n');

  const classification = await classifyEmail({
    userId: user.userId,
    tenantId: user.tenantId,
    matterId: top?.matterId ?? null,
    emailText,
  });

  const row = await queryOne<{ id: string }>(
    `insert into email_triage
      (tenant_id, graph_message_id, graph_conversation_id, matched_matter_id, confidence, band, classification, candidates)
     values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb) returning id`,
    [
      user.tenantId,
      message.id ?? null,
      message.conversationId ?? null,
      top?.matterId ?? null,
      top?.score ?? null,
      top?.band ?? 'NONE',
      JSON.stringify(classification),
      JSON.stringify(candidates),
    ]
  );

  await writeAudit({
    tenantId: user.tenantId,
    matterId: top?.matterId ?? null,
    actorUserId: user.userId,
    actionType: 'EMAIL_TRIAGED',
    actionStatus: 'SUCCESS',
    payload: { messageId: message.id, band: top?.band ?? 'NONE', confidence: top?.score ?? 0, intent: classification.intent },
  });

  return { triageId: row!.id, classification, candidates, top, band: top?.band ?? 'NONE' };
}

/**
 * Once a matter is in play, an email only ever resolves one of four ways —
 * Reply, Action, Delegate or Ignore. We mark it on arrival with the move the
 * classifier implies so the conveyancer can clear the inbox at a glance, and so
 * the marking matches the taskpane's recommended action for the same email.
 *
 * Delegation is a human call (who picks it up depends on the firm, not the
 * email), so the auto-mark only ever lands on Reply / Action / Ignore — the
 * conveyancer re-tags to Delegate when they hand it off.
 */
export type RecommendedAction = 'REPLY' | 'ACTION' | 'DELEGATE' | 'IGNORE';

// Mirrors the draft-worthiness rule in assist.ts: these intents have someone
// waiting on a written response, so the suggested move is a reply.
const REPLY_INTENTS = new Set<EmailIntent>(['ACTION_REQUIRED', 'ENQUIRY', 'CHASE', 'DOCUMENT_DELIVERY']);

export function recommendedAction(c: Classification): RecommendedAction {
  if (!c.needsAttention) return 'IGNORE';
  return REPLY_INTENTS.has(c.intent) ? 'REPLY' : 'ACTION';
}

const ACTION_LABEL: Record<RecommendedAction, string> = {
  REPLY: 'Reply',
  ACTION: 'Action',
  DELEGATE: 'Delegate',
  IGNORE: 'Ignore',
};

// The status tag carries two things: what to do (the action) and how urgent it
// is (the RAG level). Because Outlook ties one colour to one category NAME, the
// urgency has to live in the name — so the tag is "<Action> · <Urgency>" and its
// colour is driven by the urgency half. That yields a small action×urgency
// matrix of categories, each created on demand.
export type RagLevel = 'URGENT' | 'SOON' | 'FYI';

/**
 * RAG urgency for the status tag, by effect on the conveyancing critical path:
 *  - URGENT (red): a response/decision is owed now or the chain is blocked —
 *    high urgency, or someone is actively chasing us.
 *  - SOON (amber): needs the fee earner, but isn't holding anything up yet.
 *  - FYI (green): informational, no action needed.
 */
export function ragLevel(c: Classification): RagLevel {
  if (!c.needsAttention) return 'FYI';
  if (c.urgency === 'HIGH' || c.intent === 'CHASE') return 'URGENT';
  return 'SOON';
}

const RAG_LABEL: Record<RagLevel, string> = {
  URGENT: 'Urgent',
  SOON: 'Soon',
  FYI: 'FYI',
};
// Red = on the critical path, Amber = needs doing soon, Green = informational.
const RAG_COLOR: Record<RagLevel, string> = {
  URGENT: 'preset0',
  SOON: 'preset1',
  FYI: 'preset4',
};
const RAG_COLOR_BY_LABEL: Record<string, string> = {
  [RAG_LABEL.URGENT]: RAG_COLOR.URGENT,
  [RAG_LABEL.SOON]: RAG_COLOR.SOON,
  [RAG_LABEL.FYI]: RAG_COLOR.FYI,
};

// Each matter gets its own stable pill colour, cycling through this palette
// (matter N+1 loops back to the start). Deliberately excludes the RAG status
// colours (red preset0 / amber preset1 / green preset4) and the grey/steel/black
// presets, so a matter pill never reads as urgency or as "uncoloured".
const MATTER_PALETTE = [
  'preset7', 'preset8', 'preset5', 'preset3', 'preset9', 'preset6', 'preset2',
  'preset16', 'preset18', 'preset19', 'preset20', 'preset22', 'preset15', 'preset23',
];

function hashRef(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Stable per-matter pill colour (same matter ref → same colour, always). */
export function matterColor(matterRef: string): string {
  return MATTER_PALETTE[hashRef(matterRef) % MATTER_PALETTE.length];
}

/** "Reply · Urgent", "Action · Soon", "Ignore · FYI", … — name encodes both. */
function statusTagName(c: Classification): string {
  return `${ACTION_LABEL[recommendedAction(c)]} · ${RAG_LABEL[ragLevel(c)]}`;
}

/** Intended colour for a status category name, or null if it isn't one of ours. */
export function statusTagColor(displayName: string): string | null {
  const parts = displayName.split(' · ');
  if (parts.length < 2) return null;
  return RAG_COLOR_BY_LABEL[parts[parts.length - 1]] ?? null;
}

/**
 * Apply visible Outlook category tags from a triage result (best-effort): the
 * RAG status tag always, plus the matched matter ref when the match is
 * AUTO-band. Opting into auto-triage (the subscription) is the user's consent.
 */
export async function applyTriageTags(user: SessionUser, message: any, triage: TriageResult): Promise<string[]> {
  if (!message.id) return [];
  const statusTag = statusTagName(triage.classification);
  const matterTag = triage.top && triage.top.band === 'AUTO' ? triage.top.matterRef : null;
  const tags: string[] = matterTag ? [statusTag, matterTag] : [statusTag];
  for (const t of tags) {
    const color = t === statusTag ? RAG_COLOR[ragLevel(triage.classification)] : matterColor(t);
    await ensureMasterCategory(user.userId, t, color);
  }
  await addMessageCategories(user.userId, message.id, tags).catch(() => {});
  return tags;
}

interface AutoRuleRow {
  id: string;
  name: string;
  enabled: boolean;
  intents: string[];
  min_confidence: number;
  require_no_attention: boolean;
  sender_domains: string[];
  do_categorize: boolean;
  category_label: string | null;
  do_assign: boolean;
  assign_to: string | null;
  do_append_tracker: boolean;
  reply_mode: 'NONE' | 'DRAFT' | 'SEND';
  reply_template_id: string | null;
  risk_accepted: boolean;
}

export interface AutoOutcome {
  applied: boolean;
  ruleId?: string;
  ruleName?: string;
  actions: string[];
  reason?: string;
}

/**
 * Premium auto-executor. Only acts when:
 *  - tenant automation kill-switch is on,
 *  - the match band is AUTO (very high, multi-signal) and ≥ rule.min_confidence,
 *  - the classification satisfies the rule (intent + no-attention),
 *  - sender domain is in the rule's allowlist (if set).
 * SEND additionally requires the rule's re-accepted risk acknowledgement, the
 * tenant auto-send switch, and the recipient-domain policy allowlist.
 */
export async function runAutoRules(
  user: SessionUser,
  message: any,
  triage: TriageResult
): Promise<AutoOutcome> {
  if (!triage.top || triage.top.band !== 'AUTO') {
    return { applied: false, actions: [], reason: 'No AUTO-band match; left for human review.' };
  }

  const policy = await queryOne<{ automation_enabled: boolean; auto_send_enabled: boolean; allowed_external_domains: string[] }>(
    `select automation_enabled, auto_send_enabled, allowed_external_domains from policy_config where tenant_id = $1`,
    [user.tenantId]
  );
  if (!policy?.automation_enabled) {
    return { applied: false, actions: [], reason: 'Automation disabled for this firm.' };
  }
  if (!(await isPremiumTenant(user.tenantId))) {
    return { applied: false, actions: [], reason: 'Premium automation requires the Team plan.' };
  }

  const rules = await query<AutoRuleRow>(
    `select * from auto_rule where tenant_id = $1 and enabled = true order by min_confidence desc`,
    [user.tenantId]
  );

  const senderDomain = message.from?.emailAddress?.address?.split('@')[1]?.toLowerCase();
  const match = triage.top;
  const cls = triage.classification;

  const rule = rules.find((r) => {
    if (r.intents.length && !r.intents.includes(cls.intent)) return false;
    if (match.score < r.min_confidence) return false;
    if (r.require_no_attention && cls.needsAttention) return false;
    if (r.sender_domains.length && (!senderDomain || !r.sender_domains.includes(senderDomain))) return false;
    return true;
  });

  if (!rule) {
    return { applied: false, actions: [], reason: 'No enabled rule matched this email.' };
  }

  const actions: string[] = [];

  // Ensure the thread is linked to the matched matter.
  await query(
    `insert into email_thread (tenant_id, matter_id, graph_thread_id, graph_conversation_id, subject, outlook_category)
     values ($1,$2,$3,$4,$5,$6)
     on conflict (tenant_id, graph_thread_id)
     do update set matter_id = excluded.matter_id`,
    [
      user.tenantId,
      match.matterId,
      message.conversationId ?? message.id,
      message.conversationId ?? null,
      message.subject ?? null,
      rule.category_label ?? match.matterRef,
    ]
  );
  actions.push('linked-thread');

  if (rule.do_categorize && message.id) {
    const label = rule.category_label ?? match.matterRef;
    await ensureMasterCategory(user.userId, label, matterColor(label));
    await addMessageCategories(user.userId, message.id, [label]).catch(() => {});
    actions.push('categorized');
  }

  const matter = await queryOne<{ tracker_item_id: string | null }>(
    `select tracker_item_id from matter where id = $1 and tenant_id = $2`,
    [match.matterId, user.tenantId]
  );

  if (rule.do_append_tracker && matter?.tracker_item_id) {
    await appendTrackerRow(user.userId, matter.tracker_item_id, {
      date: new Date().toISOString().slice(0, 10),
      type: cls.intent,
      detail: `${cls.reason} — auto-triaged from: ${message.subject ?? ''}`.slice(0, 250),
      owner: rule.do_assign && rule.assign_to ? 'assigned' : '',
      due: '',
      status: cls.needsAttention ? 'OPEN' : 'NOTED',
    }).catch(() => {});
    actions.push('tracker-appended');
  }

  // Reply actions
  if ((rule.reply_mode === 'DRAFT' || rule.reply_mode === 'SEND') && message.id) {
    const threadText = threadToText(await listThreadMessages(user.userId, message.conversationId ?? message.id));
    const facts = await queryOne<{ facts: Record<string, unknown> }>(
      `select facts from matter_summary where matter_id = $1 and tenant_id = $2`,
      [match.matterId, user.tenantId]
    );
    const template = rule.reply_template_id
      ? await queryOne<any>(`select * from template where id = $1 and tenant_id = $2`, [rule.reply_template_id, user.tenantId])
      : null;
    const retrieved = await retrieveMatterContext({
      tenantId: user.tenantId,
      matterId: match.matterId,
      queryText: 'Acknowledge status update',
      includePlaybook: true,
      limit: 6,
    });
    const draft = await draftReply({
      userId: user.userId,
      tenantId: user.tenantId,
      matterId: match.matterId,
      tone: 'NEUTRAL',
      threadText,
      matterFacts: facts?.facts ?? {},
      retrievedContext: retrieved.map((r) => `${r.source_kind}: ${r.chunk_text}`).join('\n---\n'),
      templateText: template ? `${template.subject_template ?? ''}\n${template.body_template}` : '',
    });

    if (rule.reply_mode === 'SEND') {
      const recipients = [
        message.from?.emailAddress?.address,
        ...(message.toRecipients ?? []).map((r: any) => r.emailAddress?.address),
      ].filter(Boolean) as string[];
      const sendOk =
        rule.risk_accepted &&
        policy.auto_send_enabled &&
        externalDomainsAllowed(recipients, policy.allowed_external_domains ?? []);
      if (sendOk) {
        const id = await createAndSendReply(user.userId, message.id, draft.bodyHtml, draft.subject);
        actions.push('auto-sent');
        await writeAudit({
          tenantId: user.tenantId,
          matterId: match.matterId,
          actorUserId: user.userId,
          actionType: 'AUTO_REPLY_SENT',
          actionStatus: 'SUCCESS',
          payload: { ruleId: rule.id, draftId: id, recipients },
        });
      } else {
        // Fail safe: degrade to a draft and record why the send was blocked.
        await createReplyDraft(user.userId, message.id, draft.bodyHtml, draft.subject);
        actions.push('auto-drafted (send blocked)');
        await writeAudit({
          tenantId: user.tenantId,
          matterId: match.matterId,
          actorUserId: user.userId,
          actionType: 'AUTO_REPLY_SENT',
          actionStatus: 'BLOCKED',
          payload: { ruleId: rule.id, reason: 'risk/kill-switch/domain check failed' },
        });
      }
    } else {
      await createReplyDraft(user.userId, message.id, draft.bodyHtml, draft.subject);
      actions.push('auto-drafted');
    }
  }

  if (rule.do_assign && rule.assign_to) {
    await query(`update matter set assigned_to = $1, updated_at = now() where id = $2 and tenant_id = $3`, [
      rule.assign_to,
      match.matterId,
      user.tenantId,
    ]);
    await query(
      `insert into matter_timeline_event (tenant_id, matter_id, event_type, title, details, source_ref)
       values ($1,$2,'ASSIGNED',$3,$4,$5::jsonb)`,
      [
        user.tenantId,
        match.matterId,
        'Auto-assigned by rule',
        `Rule "${rule.name}" assigned this matter on a ${cls.intent} email`,
        JSON.stringify({ ruleId: rule.id, assignedTo: rule.assign_to }),
      ]
    );
    actions.push('assigned');
  }

  await query(
    `update email_triage set decision = 'AUTO_APPLIED', decided_at = now() where graph_message_id = $1 and tenant_id = $2`,
    [message.id ?? '', user.tenantId]
  );

  await writeAudit({
    tenantId: user.tenantId,
    matterId: match.matterId,
    actorUserId: user.userId,
    actionType: 'AUTO_RULE_APPLIED',
    actionStatus: 'SUCCESS',
    payload: { ruleId: rule.id, ruleName: rule.name, actions, confidence: match.score },
  });

  return { applied: true, ruleId: rule.id, ruleName: rule.name, actions };
}
