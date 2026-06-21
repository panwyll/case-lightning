/**
 * The "situation" composer behind the taskpane assistant.
 *
 * One call turns an open email into everything the conveyancer needs to act:
 *   triage (what is this / which matter / does it need me)
 *   + what we already know (matter facts + thread summary)
 *   + a prepared reply (only when a response is actually warranted).
 *
 * It reuses the same building blocks as the individual routes (runTriage,
 * summarizeThread, draftReply) so behaviour stays identical — it just collapses
 * the three round-trips the taskpane used to make into one.
 */
import { query, queryOne } from './db';
import { getMessage, listThreadMessages } from './graph';
import { runTriage } from './triage';
import { summarizeThread, draftReply, retrieveMatterContext } from './ai';
import { threadToText } from './text';
import type { SessionUser } from './types';
import type { Classification } from './triage';
import type { Candidate } from './matching';

// Intents where a reply is the expected next step — so we spend the draft call.
const REPLY_INTENTS = new Set(['ACTION_REQUIRED', 'ENQUIRY', 'CHASE', 'DOCUMENT_DELIVERY']);

export interface AssistResult {
  triageId: string;
  classification: Classification;
  matchBand: string;
  matter: { id: string; matterRef: string; propertyAddress: string | null } | null;
  candidates: Candidate[];
  /** One-line "what they're asking" — the classifier's reason. */
  ask: string;
  /** What we already know — thread highlights (plus matter context when linked). */
  whatWeKnow: string[];
  /** Open items / blockers standing between us and a complete answer. */
  outstanding: string[];
  /** A prepared reply, when the email warrants one; null otherwise. */
  draft: { subject: string; bodyHtml: string; why: string[]; actions: Array<{ owner: string; task: string; due: string }> } | null;
}

export async function assistOnMessage(
  user: SessionUser,
  input: { messageId: string; conversationId?: string; matterId?: string; tone?: 'NEUTRAL' | 'FIRM' | 'CHASING' }
): Promise<AssistResult> {
  const message = await getMessage(user.userId, input.messageId);
  const triage = await runTriage(user, message);

  // Use an explicitly-linked matter if given, else the matched matter when the
  // match is confident enough to act on (AUTO band).
  const matterId = input.matterId ?? (triage.top?.band === 'AUTO' ? triage.top.matterId : null);

  // Prefer the conversationId off the fetched message — it's Graph's own REST
  // value, whereas a client-supplied one may be an Office/EWS id that matches no
  // thread. Fall back only if the message somehow lacks it.
  const conversationId = message.conversationId ?? input.conversationId ?? input.messageId;
  const threadText = threadToText(await listThreadMessages(user.userId, conversationId));

  let matter: AssistResult['matter'] = null;
  let facts: Record<string, unknown> = {};
  let matterOutstanding: string[] = [];
  if (matterId) {
    matter = await queryOne<{ id: string; matterRef: string; propertyAddress: string | null }>(
      `select id, matter_ref as "matterRef", property_address as "propertyAddress" from matter where id = $1 and tenant_id = $2`,
      [matterId, user.tenantId]
    );
    const summaryRow = await queryOne<{ facts: Record<string, unknown>; outstanding_items: string[] }>(
      `select facts, outstanding_items from matter_summary where matter_id = $1 and tenant_id = $2`,
      [matterId, user.tenantId]
    );
    facts = summaryRow?.facts ?? {};
    matterOutstanding = summaryRow?.outstanding_items ?? [];
  }

  const summary = await summarizeThread({
    userId: user.userId,
    tenantId: user.tenantId,
    matterId,
    threadText,
    matterSummary: JSON.stringify(facts),
  });

  // Decide whether to prepare a reply at all — don't burn the call on pure FYIs.
  const wantsReply = triage.classification.needsAttention || REPLY_INTENTS.has(triage.classification.intent);
  let draft: AssistResult['draft'] = null;
  if (wantsReply) {
    const tone = input.tone ?? (triage.classification.intent === 'CHASE' ? 'CHASING' : 'NEUTRAL');

    const template = await queryOne<any>(
      `select * from template where tenant_id = $1 and style_tag = $2 and is_active = true order by updated_at desc limit 1`,
      [user.tenantId, tone]
    );
    const policy = await queryOne<{ default_disclaimer: string }>(
      `select default_disclaimer from policy_config where tenant_id = $1`,
      [user.tenantId]
    );
    const retrieved = matterId
      ? await retrieveMatterContext({
          tenantId: user.tenantId,
          matterId,
          queryText: `Draft reply for ${message.subject ?? 'this thread'}`,
          includePlaybook: true,
          limit: 10,
        })
      : [];
    const retrievedContext = retrieved.map((r) => `${r.source_kind}: ${r.chunk_text}`).join('\n---\n');
    const templateText = `${template ? `${template.subject_template ?? ''}\n${template.body_template}` : ''}\n${policy?.default_disclaimer ?? ''}`;

    const generated = await draftReply({
      userId: user.userId,
      tenantId: user.tenantId,
      matterId,
      tone,
      threadText,
      matterFacts: facts,
      retrievedContext,
      templateText,
    });
    draft = { subject: generated.subject, bodyHtml: generated.bodyHtml, why: generated.why, actions: generated.actions };
  }

  // Prefer the matter's tracked outstanding items as the "blockers"; fall back to
  // what the thread summary surfaced when there's no matter yet.
  const outstanding = matterOutstanding.length ? matterOutstanding : summary.outstanding;

  return {
    triageId: triage.triageId,
    classification: triage.classification,
    matchBand: triage.band,
    matter,
    candidates: triage.candidates,
    ask: triage.classification.reason,
    whatWeKnow: summary.happened,
    outstanding,
    draft,
  };
}
