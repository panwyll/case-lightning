/**
 * The "situation" composer behind the taskpane assistant.
 *
 * One open email becomes everything the conveyancer needs to act:
 *   triage (what is this / which matter / does it need me)
 *   + what we already know (matter facts + thread summary)
 *   + a prepared reply (only when a response is actually warranted).
 *
 * Split into two phases so the taskpane can feel instant:
 *   - FAST  (assistPhase1): match + classification + tags. Matching is pure DB
 *     (no tokens); classification is reused from the webhook's triage row when
 *     present, so the common path makes ZERO AI calls.
 *   - SLOW  (assistPhase2): thread summary + drafted reply — the two expensive
 *     LLM calls. Precomputed on receipt by the webhook (see assist-cache), or
 *     filled in the background on a cold open while the taskpane shows the fast
 *     half immediately.
 */
import { query, queryOne } from './db';
import { getMessage, listThreadMessages } from './graph';
import { runTriage, applyTriageTags } from './triage';
import { summarizeThread, draftReply, retrieveMatterContext, actingForPhrase } from './ai';
import { summarizeAttachments, attachmentGroundTruth, type AttachmentDoc } from './files';
import { recordContactsFromMessage } from './contacts';
import { threadToText } from './text';
import type { SessionUser } from './types';
import type { Classification, TriageResult } from './triage';
import { hasDefinitiveSignal, hasTrustedLink, type Candidate } from './matching';

// Intents where a reply is the expected next step — so we spend the draft call.
const REPLY_INTENTS = new Set(['ACTION_REQUIRED', 'ENQUIRY', 'CHASE', 'DOCUMENT_DELIVERY']);

/** The fast half: everything available without an LLM round-trip on the thread. */
export interface FastAssist {
  triageId: string;
  classification: Classification;
  matchBand: string;
  matter: { id: string; matterRef: string; propertyAddress: string | null } | null;
  candidates: Candidate[];
  /** One-line "what they're asking" — the classifier's reason. */
  ask: string;
  /** Outlook category tags applied to the message so it stands out in the list. */
  highlighted: string[];
}

/** The slow half: the two LLM-backed pieces (thread summary + prepared reply). */
export interface SlowAssist {
  /** A short, assistant-voice heads-up: what this email is, where the case is, what to do next. */
  brief: string;
  /** What we already know — thread highlights (plus matter context when linked). */
  whatWeKnow: string[];
  /** Open items / blockers standing between us and a complete answer. */
  outstanding: string[];
  /** A prepared reply, when the email warrants one; null otherwise. */
  draft: { subject: string; bodyHtml: string; why: string[]; actions: Array<{ owner: string; task: string; due: string }> } | null;
  /** Per-attachment summaries (what each document is and its key points), for the email tab. */
  documents: AttachmentDoc[];
}

export type AssistResult = FastAssist & SlowAssist;

export interface AssistInput {
  messageId: string;
  conversationId?: string;
  matterId?: string;
  tone?: 'NEUTRAL' | 'FIRM' | 'CHASING';
}

/** Empty slow half — what a PARTIAL (fast-only) result carries until the slow half lands. */
export function emptySlow(): SlowAssist {
  return { brief: '', whatWeKnow: [], outstanding: [], draft: null, documents: [] };
}

// Internal context handed from the fast phase to the slow phase so the slow
// phase doesn't have to re-fetch the message or re-resolve the matter.
interface AssistContext {
  message: any;
  conversationId: string;
  matterId: string | null;
  facts: Record<string, unknown>;
  matterOutstanding: string[];
  track: string | null;
  intent: string;
  needsAttention: boolean;
  tone?: AssistInput['tone'];
}

/**
 * Reuse the classification the webhook already computed for this message, so the
 * taskpane never re-runs the classify call. Returns null when no triage row
 * exists yet (cold open of old mail) — the caller then runs triage live.
 */
async function loadStoredTriage(tenantId: string, messageId: string): Promise<TriageResult | null> {
  const row = await queryOne<{ id: string; classification: Classification; candidates: Candidate[]; band: string }>(
    `select id, classification, candidates, band
     from email_triage where tenant_id = $1 and graph_message_id = $2
     order by created_at desc limit 1`,
    [tenantId, messageId]
  );
  if (!row) return null;
  const candidates = Array.isArray(row.candidates) ? row.candidates : [];
  const top = candidates[0] ?? null;
  return { triageId: row.id, classification: row.classification, candidates, top, band: top?.band ?? 'NONE' };
}

async function buildFast(user: SessionUser, input: AssistInput): Promise<{ fast: FastAssist; ctx: AssistContext }> {
  const message = await getMessage(user.userId, input.messageId);

  // Reuse the webhook's triage when we're not pinned to a specific matter; an
  // explicit matterId means a deliberate re-analysis, so compute fresh.
  let triage = input.matterId ? null : await loadStoredTriage(user.tenantId, input.messageId);
  if (!triage) triage = await runTriage(user, message);

  // READ a matter into the draft (facts, RAG, attachment review) on an explicit link
  // or a DEFINITIVE match (linked thread / case-ref token) — these only surface case
  // data to the firm's own reviewer. A fuzzy AUTO match (corroboration only) is shown
  // as a suggestion, never injected.
  const definitiveMatch = triage.top?.band === 'AUTO' && hasDefinitiveSignal(triage.top);
  const matterId = input.matterId ?? (definitiveMatch ? triage.top!.matterId : null);
  // WRITE to a matter (harvest contacts here; attachments are auto-filed in the
  // webhook) only on a TRUSTED LINK the firm created — never the case-ref token,
  // which lives in attacker-controlled email content and could poison the case.
  const writeMatterId = input.matterId ?? (hasTrustedLink(triage.top) ? triage.top!.matterId : null);

  // Prefer the conversationId off the fetched message — it's Graph's own REST
  // value, whereas a client-supplied one may be an Office/EWS id that matches no
  // thread. Fall back only if the message somehow lacks it.
  const conversationId = message.conversationId ?? input.conversationId ?? input.messageId;

  let matter: FastAssist['matter'] = null;
  let facts: Record<string, unknown> = {};
  let matterOutstanding: string[] = [];
  let track: string | null = null;
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
    // Which side we act for — guarded so a deploy before migration 020 still works.
    try {
      const t = await queryOne<{ track: string }>(`select track from matter where id = $1 and tenant_id = $2`, [matterId, user.tenantId]);
      track = t?.track ?? null;
    } catch {
      /* track column not migrated yet */
    }

    // Harvest contacts into the matter's address book only on a trusted link — never
    // on a token/fuzzy match (a persisted write off attacker-controllable content).
    if (writeMatterId) await recordContactsFromMessage(user, writeMatterId, message).catch(() => {});
  }

  // Highlight the email in the Outlook message list (coloured categories) so it
  // stands out at a glance — best-effort, never fails the analysis.
  let highlighted: string[] = [];
  try {
    highlighted = await applyTriageTags(user, message, triage);
  } catch {
    /* category APIs unavailable on this mailbox — skip silently */
  }

  // An explicit matterId means the user deliberately linked (or just created) this
  // matter for this email — that's authoritative, so present it as a definitive
  // match rather than whatever tenuous other-case the fuzzy matcher surfaced. The
  // linked matter leads the candidate list so the UI shows a perfect match.
  const explicitlyLinked = Boolean(input.matterId && matter);
  // Present a fuzzy AUTO match (not adopted for data) as a STRONG suggestion to
  // confirm, not a done deal — keeps the display honest with the no-inject gate.
  const fuzzyAuto = !input.matterId && triage.top?.band === 'AUTO' && !definitiveMatch;
  const matchBand = explicitlyLinked ? 'AUTO' : fuzzyAuto ? 'STRONG' : triage.band;
  const candidates = explicitlyLinked
    ? [
        {
          matterId: matter!.id,
          matterRef: matter!.matterRef,
          propertyAddress: matter!.propertyAddress ?? '',
          score: 1,
          band: 'AUTO' as const,
          signals: [{ kind: 'LINKED_THREAD' as const, detail: 'Linked to this matter', weight: 1 }],
        },
        ...triage.candidates.filter((c) => c.matterId !== matter!.id),
      ]
    : triage.candidates;

  const fast: FastAssist = {
    triageId: triage.triageId,
    classification: triage.classification,
    matchBand,
    matter,
    candidates,
    ask: triage.classification.reason,
    highlighted,
  };
  const ctx: AssistContext = {
    message,
    conversationId,
    matterId,
    facts,
    matterOutstanding,
    track,
    intent: triage.classification.intent,
    needsAttention: triage.classification.needsAttention,
    tone: input.tone,
  };
  return { fast, ctx };
}

async function buildSlow(user: SessionUser, ctx: AssistContext): Promise<SlowAssist> {
  const threadText = threadToText(await listThreadMessages(user.userId, ctx.conversationId));

  const summary = await summarizeThread({
    userId: user.userId,
    tenantId: user.tenantId,
    matterId: ctx.matterId,
    threadText,
    matterSummary: JSON.stringify(ctx.facts),
  });

  // Review any attachments ONCE — the per-document summaries surface in the email tab, and
  // the same review grounds the reply below (so we don't read the documents twice).
  let attachDocs: AttachmentDoc[] = [];
  let attachContext = '';
  if (ctx.matterId && ctx.message?.hasAttachments && ctx.message?.id) {
    const att = await summarizeAttachments(user, ctx.matterId, ctx.message.id).catch(() => ({ documents: [] as AttachmentDoc[], context: '' }));
    attachDocs = att.documents;
    attachContext = att.context;
  }

  // Decide whether to prepare a reply at all — don't burn the call on pure FYIs.
  const wantsReply = ctx.needsAttention || REPLY_INTENTS.has(ctx.intent);
  let draft: SlowAssist['draft'] = null;
  if (wantsReply) {
    const tone = ctx.tone ?? (ctx.intent === 'CHASE' ? 'CHASING' : 'NEUTRAL');

    const template = await queryOne<any>(
      `select * from template where tenant_id = $1 and style_tag = $2 and is_active = true order by updated_at desc limit 1`,
      [user.tenantId, tone]
    );
    const policy = await queryOne<{ default_disclaimer: string }>(
      `select default_disclaimer from policy_config where tenant_id = $1`,
      [user.tenantId]
    );
    const retrieved = ctx.matterId
      ? await retrieveMatterContext({
          tenantId: user.tenantId,
          matterId: ctx.matterId,
          queryText: `Draft reply for ${ctx.message.subject ?? 'this thread'}`,
          includePlaybook: true,
          limit: 10,
        })
      : [];
    let retrievedContext = retrieved.map((r) => `${r.source_kind}: ${r.chunk_text}`).join('\n---\n');
    // Fold the already-computed attachment review into the draft context (no second read).
    if (attachContext) retrievedContext = retrievedContext ? `${retrievedContext}\n---\n${attachContext}` : attachContext;
    const templateText = `${template ? `${template.subject_template ?? ''}\n${template.body_template}` : ''}\n${policy?.default_disclaimer ?? ''}`;

    // Ground truth on what's actually attached, so the drafter never thanks for an
    // enclosure that isn't there. Cheap: hasAttachments=false skips the Graph call.
    const attachmentSummary = ctx.message?.id
      ? await attachmentGroundTruth(user.userId, ctx.message.id, { hasAttachments: !!ctx.message?.hasAttachments }).catch(() => '')
      : '';

    const generated = await draftReply({
      userId: user.userId,
      tenantId: user.tenantId,
      matterId: ctx.matterId,
      tone,
      actingFor: actingForPhrase(ctx.track),
      threadText,
      matterFacts: ctx.facts,
      retrievedContext,
      templateText,
      attachmentSummary,
    });
    draft = { subject: generated.subject, bodyHtml: generated.bodyHtml, why: generated.why, actions: generated.actions };
  }

  // Prefer the matter's tracked outstanding items as the "blockers"; fall back to
  // what the thread summary surfaced when there's no matter yet.
  const outstanding = ctx.matterOutstanding.length ? ctx.matterOutstanding : summary.outstanding;

  return { brief: summary.brief, whatWeKnow: summary.happened, outstanding, draft, documents: attachDocs };
}

/** Fast phase only — returns the fast half plus the context the slow phase needs. */
export async function assistPhase1(user: SessionUser, input: AssistInput): Promise<{ fast: FastAssist; ctx: AssistContext }> {
  return buildFast(user, input);
}

/** Slow phase — the two LLM calls. Takes the context produced by phase 1. */
export async function assistPhase2(user: SessionUser, ctx: AssistContext): Promise<SlowAssist> {
  return buildSlow(user, ctx);
}

/** Full assist (fast + slow) in one call — the cold/explicit-matter path and the webhook's precompute. */
export async function assistOnMessage(user: SessionUser, input: AssistInput): Promise<AssistResult> {
  const { fast, ctx } = await buildFast(user, input);
  const slow = await buildSlow(user, ctx);
  return { ...fast, ...slow };
}
