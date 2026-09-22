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
import { CLIENT_DECISION_OUTCOMES, CLIENT_DECISION_SUBJECTS, type ClientDecisionSubject, type NoteAction, type NoteActionKind, type NoteCommand, type NoteKind } from './types';
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
export function validateNoteActions(text: string, drafts: NoteActionDraft[]): ValidationResult {
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
    actions.push({
      id: `A${actions.length + 1}`,
      kind: d.kind,
      summary,
      quote,
      confidence: typeof d.confidence === 'number' ? Math.max(0, Math.min(1, d.confidence)) : 0.6,
      command,
    });
  }
  return { actions, rejected };
}

/** Why this command could never run. null = it is a command the machine accepts. */
export function commandProblem(c: NoteCommand): string | null {
  if (c.type === 'client_decision_recorded') {
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
export function summariseNoteActions(input: { kind: NoteKind; text: string; actions: NoteAction[]; author?: string | null }): string {
  const L: string[] = [];
  const source = input.kind === 'call' ? 'A call' : input.kind === 'dictated' ? 'A dictated note' : input.kind === 'meeting' ? 'A meeting note' : 'A note';
  L.push(`${source} on this matter appears to record ${input.actions.length} thing${input.actions.length === 1 ? '' : 's'} the case should know about. Nothing has been applied — approve to apply, or reject with a reason.`);
  L.push('');
  for (const a of input.actions) {
    const effect = !a.command
      ? 'For information only — nothing to record.'
      : a.command.type === 'client_decision_recorded'
      ? `Would record the client's decision: ${a.command.subject.replace(/_/g, ' ')} = ${a.command.decision.replace(/_/g, ' ')}.`
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
