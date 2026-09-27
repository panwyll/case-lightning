/**
 * Notes and call transcripts → proposed case events (docs/intake.md).
 *
 * A conveyancer rings a client. The client says they are happy with the damp report and
 * wants to proceed, and mentions the broker expects a revised offer on Friday. Today that
 * conversation lives in somebody's memory and, at best, a file note nobody re-reads.
 *
 * This module turns those words into PROPOSALS — never into state. Each proposal:
 *   • maps to exactly one command the machine already accepts (a client decision, or an
 *     issue), so nothing can enter the case by a side door;
 *   • must quote the words it came from, verbatim, or it is thrown away. A model that
 *     invents an instruction nobody gave cannot point at the sentence that gave it;
 *   • is applied only when a person approves it, because a transcript is one person's
 *     account of what was said and the conveyancer owns the file.
 *
 * The extractor itself is a port. Without a model key the deterministic reader below
 * still catches the unambiguous phrasings, so the feature degrades to "less", not "wrong".
 */
import { CLIENT_DECISION_OUTCOMES, CLIENT_DECISION_SUBJECTS, type ClientDecisionSubject, type NoteAction, type NoteActionKind, type NoteCommand, type NoteKind, type NoteSender, type SenderRelation } from './types';
import { ISSUE_KIND_SPEC, type IssueGate, type IssueKind } from './issues';

/** What an extractor hands back, before validation. */
export interface NoteActionDraft {
  kind: NoteActionKind;
  summary: string;
  quote: string;
  confidence?: number;
  command?: NoteCommand | null;
}

export interface NoteExtractionContext {
  tenantId: string;
  matterId: string;
  text: string;
  kind: NoteKind;
  /** A one-line account of the matter, so an extractor can tell "the survey" from "a survey". */
  caseLine?: string;
  /** For an email: who sent it, as far as the case knows. */
  from?: NoteSender | null;
}

/** Where a note's words come from: decides what they may propose. */
export interface NoteSource { kind: NoteKind; from?: NoteSender | null }

export const RELATION_LABEL: Record<SenderRelation, string> = {
  client: 'the client',
  agent: 'the estate agent',
  other_side: "the other side",
  lender: 'the lender or broker',
  colleague: 'a colleague',
  unknown: 'someone the case does not know',
};

/**
 * What the sender is allowed to put in front of a person. Only the client can make a
 * client decision: an agent saying "the buyer is happy with the survey" is hearsay and is
 * shown for information. A problem may be reported by anyone. Nothing anyone says can
 * clear ID, AML, source of funds or a search: those are not commands a note can name,
 * so the machine has no door for them (commandProblem).
 */
export function senderPolicy(source: NoteSource | undefined, action: NoteAction): NoteAction {
  if (!source || source.kind !== 'email') return action;
  const relation = source.from?.relation ?? 'unknown';
  if (action.command?.type === 'client_decision_recorded' && relation !== 'client') {
    // Hearsay about the client is not dropped: the client is asked, and their own answer is what gets recorded.
    const saidBy = source.from?.name || source.from?.address || RELATION_LABEL[relation];
    return {
      ...action,
      kind: 'confirm_with_client',
      summary: `${RELATION_LABEL[relation]} says: ${action.summary.replace(/^The client /, 'the client ')}. Ask the client to confirm; nothing is recorded until they do`,
      command: { type: 'confirm_with_client', subject: action.command.subject, decision: action.command.decision, saidBy, quote: action.quote },
    };
  }
  return action;
}

/** The claim put to the client, in their terms: "you are happy with the survey and want to proceed". */
export function claimText(subject: ClientDecisionSubject, decision: string): string {
  const k = `${subject}:${decision}`;
  const known: Record<string, string> = {
    'physical_condition:satisfied': 'you are happy with the survey and want to proceed',
    'physical_condition:renegotiate': 'you want to renegotiate the price following the survey',
    'physical_condition:further_investigation': 'you want the further investigation the surveyor recommended',
    'physical_condition:withdraw': 'you no longer wish to proceed with the purchase',
    'further_investigation:pursue': 'you want the further investigation the surveyor recommended carried out',
    'further_investigation:waive': 'you are content to proceed without the further investigation the surveyor recommended',
    'exchange_authority:authorised': 'you authorise us to exchange contracts',
    'exchange_authority:not_yet': 'you are not yet ready for us to exchange contracts',
    'exchange_authority:withdrawn': 'you have withdrawn your authority to exchange contracts',
  };
  return known[k] ?? `your decision on ${subject.replace(/_/g, ' ')} is "${decision.replace(/_/g, ' ')}"`;
}

/** Whitespace-insensitive containment: a quote must really be in the note. */
const norm = (s: string) => s.toLowerCase().replace(/[‘’“”]/g, "'").replace(/\s+/g, ' ').trim();

export interface ValidationResult {
  actions: NoteAction[];
  /** What was dropped and why — kept so the log can show that something was refused. */
  rejected: Array<{ summary: string; reason: string }>;
}

/**
 * Keep only the proposals that (a) quote the note, (b) name a command the machine will
 * accept, and (c) are not duplicates. Everything else is dropped with a reason.
 */
export function validateNoteActions(text: string, drafts: NoteActionDraft[], source?: NoteSource): ValidationResult {
  const body = norm(text);
  const actions: NoteAction[] = [];
  const rejected: ValidationResult['rejected'] = [];
  const seen = new Set<string>();
  for (const d of drafts) {
    const summary = (d.summary ?? '').trim();
    const quote = (d.quote ?? '').trim();
    if (!summary) {
      rejected.push({ summary: '(no summary)', reason: 'the proposal says nothing' });
      continue;
    }
    if (!quote || !body.includes(norm(quote))) {
      rejected.push({ summary, reason: 'the quoted words are not in the note' });
      continue;
    }
    const key = `${d.kind}:${norm(summary)}`;
    if (seen.has(key)) {
      rejected.push({ summary, reason: 'duplicate' });
      continue;
    }
    let command: NoteCommand | null = null;
    if (d.command) {
      const bad = commandProblem(d.command);
      if (bad) {
        rejected.push({ summary, reason: bad });
        continue;
      }
      command = d.command;
    }
    seen.add(key);
    actions.push(senderPolicy(source, {
      id: `A${actions.length + 1}`,
      kind: d.kind,
      summary,
      quote,
      confidence: typeof d.confidence === 'number' ? Math.max(0, Math.min(1, d.confidence)) : 0.6,
      command,
    }));
  }
  return { actions, rejected };
}

/** Why this command could never run. null = it is a command the machine accepts. */
export function commandProblem(c: NoteCommand): string | null {
  if (c.type === 'client_decision_recorded' || c.type === 'confirm_with_client') {
    if (!(CLIENT_DECISION_SUBJECTS as readonly string[]).includes(c.subject)) return `"${c.subject}" is not a client decision the engine knows`;
    const allowed = CLIENT_DECISION_OUTCOMES[c.subject as ClientDecisionSubject] ?? [];
    if (!allowed.includes(c.decision)) return `"${c.decision}" is not an outcome for ${c.subject.replace(/_/g, ' ')}`;
    return null;
  }
  if (c.type === 'raise_issue') {
    if (!ISSUE_KIND_SPEC[c.kind as IssueKind]) return `"${c.kind}" is not an issue kind`;
    if (!c.title?.trim()) return 'the issue has no title';
    if (!['exchange', 'completion', 'none'].includes(c.gate)) return `"${c.gate}" is not a gate`;
    return null;
  }
  return 'unknown command';
}

/** The decision a person sees: what the note appears to say, and the words behind each line. */
export function summariseNoteActions(input: { kind: NoteKind; text: string; actions: NoteAction[]; author?: string | null; from?: NoteSender | null }): string {
  const L: string[] = [];
  const who = input.from ? `${input.from.name || input.from.address} (${RELATION_LABEL[input.from.relation]})` : 'someone';
  const source = input.kind === 'call' ? 'A call' : input.kind === 'dictated' ? 'A dictated note' : input.kind === 'meeting' ? 'A meeting note' : input.kind === 'email' ? `An email from ${who}` : 'A note';
  L.push(`${source} on this matter appears to record ${input.actions.length} thing${input.actions.length === 1 ? '' : 's'} the case should know about. Nothing has been applied — approve to apply, or reject with a reason.`);
  L.push('');
  for (const a of input.actions) {
    const effect = !a.command
      ? 'For information only — nothing to record.'
      : a.command.type === 'client_decision_recorded'
      ? `Would record the client's decision: ${a.command.subject.replace(/_/g, ' ')} = ${a.command.decision.replace(/_/g, ' ')}.`
      : a.command.type === 'confirm_with_client'
      ? `Would ask the client to confirm that ${claimText(a.command.subject, a.command.decision)}. Recorded only when they say so themselves.`
      : `Would raise a ${ISSUE_KIND_SPEC[a.command.kind]?.label ?? a.command.kind} issue${a.command.gate === 'none' ? ' (holding nothing)' : `, holding ${a.command.gate}`}.`;
    L.push(`${a.id}. ${a.summary}`);
    L.push(`    “${a.quote}”`);
    L.push(`    ${effect}`);
  }
  L.push('');
  L.push('The note itself is on the file as the evidence for every line above.');
  return L.join('\n');
}

// ───────────────────────────── the deterministic reader ─────────────────────────────

/**
 * What a careful reader can take from a note without a model: only unambiguous phrasings,
 * each anchored to the sentence it came from. Conservative on purpose — everything it
 * proposes still goes to a person, but a false positive wastes that person's attention.
 */
const SENTENCE = /[^.!?\n]+[.!?]?/g;

interface Rule {
  test: RegExp;
  /** A second condition the same sentence must meet (e.g. "survey" AND "happy"). */
  also?: RegExp;
  /** Not this — a negation or a different subject. */
  not?: RegExp;
  build: (sentence: string) => NoteActionDraft;
}

const RULES: Rule[] = [
  {
    // "happy with the survey and wants to proceed" — the client's view of the physical condition.
    test: /\b(happy|satisfied|content|fine)\b/i,
    also: /\b(survey|report|damp|timber|structural|valuation|condition)\b/i,
    not: /\b(not|isn'?t|unhappy|un-?satisfied|except|but not)\b/i,
    build: (sentence) => ({
      kind: 'client_decision',
      summary: 'The client is satisfied with the physical condition of the property',
      quote: sentence,
      confidence: 0.72,
      command: { type: 'client_decision_recorded', subject: 'physical_condition', decision: 'satisfied', note: sentence.trim().slice(0, 400) },
    }),
  },
  {
    // "wants to renegotiate on the back of the damp report"
    test: /\b(renegotiat|reduce the price|price reduction|knock (something|money) off)\b/i,
    build: (sentence) => ({
      kind: 'client_decision',
      summary: 'The client wants to renegotiate after the survey',
      quote: sentence,
      confidence: 0.7,
      command: { type: 'client_decision_recorded', subject: 'physical_condition', decision: 'renegotiate', note: sentence.trim().slice(0, 400) },
    }),
  },
  {
    // "authorises us to exchange" — the client's authority, which the firm may require.
    test: /\b(authoris|authoriz)\w*\b.*\bexchange\b|\bexchange\b.*\b(authoris|authoriz)\w*/i,
    not: /\b(not|cannot|can'?t|won'?t|hold off|wait)\b/i,
    build: (sentence) => ({
      kind: 'client_decision',
      summary: 'The client authorises exchange',
      quote: sentence,
      confidence: 0.7,
      command: { type: 'client_decision_recorded', subject: 'exchange_authority', decision: 'authorised', note: sentence.trim().slice(0, 400) },
    }),
  },
  {
    // "broker expects the revised offer on Friday" — something we are now waiting for.
    test: /\b(expect\w*|due|coming|chasing|should (have|come|arrive|be))\b/i,
    also: /\b(offer|mortgage|lender|broker|pack|replies|statement|consent|search|report)\b/i,
    build: (sentence) => ({
      kind: 'expectation',
      summary: `Something is expected: ${sentence.trim().slice(0, 120)}`,
      quote: sentence,
      confidence: 0.55,
      command: { type: 'raise_issue', kind: 'mortgage_offer_outstanding', title: sentence.trim().slice(0, 160), detail: 'Raised from a note — the engine will chase it if it does not arrive.', gate: 'none' },
    }),
  },
  {
    // "surveys are all complete" — the report exists somewhere; ask for it. Nothing about the
    // property is recorded until the report itself is on file.
    test: /\bsurvey/i,
    also: /\b(done|complete|completed|back|through|carried out|finished|all in|has happened|took place|went ahead)\b/i,
    not: /\b(not|hasn'?t|haven'?t|isn'?t|aren'?t|yet|waiting|book|booked|arrang\w*|instruct\w*|when|once|will be|happy|satisfied)\b/i,
    build: (sentence) => ({
      kind: 'issue',
      summary: 'The survey has been done; the report is not on file yet',
      quote: sentence,
      confidence: 0.7,
      command: { type: 'raise_issue', kind: 'survey_report_outstanding', title: 'Survey done; ask the client for the report', detail: sentence.trim().slice(0, 400), gate: 'none' },
    }),
  },
  {
    // "the vendor has pulled out", "the chain has collapsed" — critical, and confirmed with the solicitors, never acted on.
    test: /\b(pull(ed|ing|s)? out|fallen through|fall(s|ing)? through|chain (has |is )?(collapsed|broken|gone)|gazump\w*|no longer (want\w*|wish\w*|able) to (proceed|buy|sell|go ahead)|not (going|proceeding) ahead|(vendor|seller|buyer|purchaser)s? (has |have |is |are )?(withdrawn|withdrawing))\b/i,
    build: (sentence) => ({
      kind: 'issue',
      summary: 'The transaction may be falling through',
      quote: sentence,
      confidence: 0.75,
      command: { type: 'raise_issue', kind: 'transaction_at_risk', title: sentence.trim().slice(0, 160), detail: 'Said in an email or a note. Confirm with the solicitors before anything is done about it.', gate: 'exchange' },
    }),
  },
  {
    // "I've lost my job so the mortgage may be a problem" — a change the lender must hear about before exchange.
    test: /\b(lost (my|his|her|their) job|redundan\w*|job (has )?changed|chang\w* (my|his|her|their) job|new job|(mortgage|offer|application) (is|may be|might be|could be|will be) (a problem|in doubt|at risk|affected)|(mortgage|offer|application)( has been| was)? (declined|refused|withdrawn|rejected|pulled)|(income|salary|pay) (has )?(dropped|changed|reduced|gone down|fallen))\b/i,
    build: (sentence) => ({
      kind: 'issue',
      summary: 'The mortgage may be at risk',
      quote: sentence,
      confidence: 0.7,
      command: { type: 'raise_issue', kind: 'mortgage_at_risk', title: sentence.trim().slice(0, 160), detail: 'Said in an email or a note. Confirm with the broker whether the offer stands; report a material change to the lender before exchange.', gate: 'exchange' },
    }),
  },
  {
    // a problem mentioned in passing — raised as an issue for a person to classify properly.
    test: /\b(boundary|dispute|japanese knotweed|knotweed|subsidence|flying freehold|unregistered|no building regs?|without (planning|building)|damp problem|leak)\b/i,
    build: (sentence) => ({
      kind: 'issue',
      summary: `A possible problem was mentioned: ${sentence.trim().slice(0, 120)}`,
      quote: sentence,
      confidence: 0.6,
      command: { type: 'raise_issue', kind: 'boundary_discrepancy', title: sentence.trim().slice(0, 160), detail: 'Mentioned in a note; classify it properly when you pick it up.', gate: 'none' },
    }),
  },
];

export class DeterministicNoteReader {
  readonly name = 'deterministic-note-reader';
  async extract(input: NoteExtractionContext): Promise<NoteActionDraft[]> {
    const sentences = (input.text.match(SENTENCE) ?? []).map((s) => s.trim()).filter((s) => s.length > 8);
    const out: NoteActionDraft[] = [];
    const used = new Set<string>();
    for (const sentence of sentences) {
      for (const r of RULES) {
        if (!r.test.test(sentence)) continue;
        if (r.also && !r.also.test(sentence)) continue;
        if (r.not && r.not.test(sentence)) continue;
        const draft = r.build(sentence);
        const key = `${draft.kind}:${draft.summary}`;
        if (used.has(key)) continue;
        used.add(key);
        out.push(draft);
        break; // one reading per sentence — the most specific rule that fires
      }
    }
    return out;
  }
}
