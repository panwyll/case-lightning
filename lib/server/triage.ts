/**
 * Triage = (deterministic match) + (LLM classification) + (audit record). The
 * premium executor that acts on a triage result (AUTO automations) lives in
 * automations.ts (runAutoAutomations). Everything here is fully audited and
 * matter-isolated.
 */
import { query, queryOne } from './db';
import { matchMessage, messageSignals, hasTrustedLink, type Candidate } from './matching';
import { maybeAdvanceStage } from './stage-inference';
import { onStageAdvanced } from './tasks';
import { classifyEmail, type EmailIntent } from './ai';
import { ensureMasterCategory, addMessageCategories } from './graph';
import { matterColor } from './colors';
import { stripHtml } from './text';
import { writeAudit } from './audit';
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
    // The full labelling decision, so "how was this email labelled?" is answerable
    // from one audit row (feeds v_email_journey): intent + urgency + needs-you, the
    // recommended move and the RAG status tag we applied, plus the matter match.
    payload: {
      messageId: message.id,
      conversationId: message.conversationId ?? null,
      band: top?.band ?? 'NONE',
      confidence: top?.score ?? 0,
      matterRef: top?.matterRef ?? null,
      intent: classification.intent,
      urgency: classification.urgency,
      needsAttention: classification.needsAttention,
      recommendedAction: recommendedAction(classification),
      statusTag: statusTagName(classification),
    },
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

/** "Reply · Urgent", "Action · Soon", "Ignore · FYI", … — name encodes both. */
function statusTagName(c: Classification): string {
  return `${ACTION_LABEL[recommendedAction(c)]} · ${RAG_LABEL[ragLevel(c)]}`;
}

/**
 * Apply visible Outlook category tags from a triage result (best-effort): the
 * RAG status tag always, plus the matched matter ref when the match is
 * AUTO-band. Opting into auto-triage (the subscription) is the user's consent.
 */
export async function applyTriageTags(user: SessionUser, message: any, triage: TriageResult): Promise<string[]> {
  if (!message.id) return [];
  // Email-driven board: on a firm-linked thread (the only write-safe signal), let the
  // message's content advance the matter's stage — the kanban maintains itself instead
  // of being a second tracker to feed. Forward-only; provenance goes on the timeline.
  if (triage.top?.matterId && hasTrustedLink(triage.top)) {
    const text = `${message.subject ?? ''}\n${typeof message.body?.content === 'string' ? message.body.content : message.bodyPreview ?? ''}`;
    const mId = triage.top.matterId;
    void maybeAdvanceStage(user.tenantId, mId, text, message.subject ?? null)
      .then((advanced) => (advanced ? onStageAdvanced(user, mId, advanced) : undefined)) // milestone → drafted update
      .catch(() => {});
  }
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
