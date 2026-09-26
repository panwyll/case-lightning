/**
 * The DETERMINISTIC rule layer (component #3, "harnessed, not freeform").
 *
 * Extraction (#2) turns a document into typed facts; these functions turn facts into
 * a verdict: CLEAR (auto-advance, no human) or FLAG (a decision for a human). No
 * model is consulted here — an LLM may read and summarise, but it never decides.
 * Every flag keeps the locator the extractor gave it, so the decision can cite the
 * page/section it came from.
 *
 * Two universal rules, applied before anything domain-specific:
 *   1. Low extraction confidence is ALWAYS a flag. Never guess on a blurry scan.
 *   2. Anything outside v1 scope (leasehold, unknown tenure) is flagged for full
 *      manual handling rather than half-automated.
 *
 * Summaries produced here are the deterministic fallback for the decision text —
 * plain English assembled from the flags and a small "what this usually means"
 * table. The AI summariser port (ports.ts) may replace the prose; it may not
 * change the verdict.
 */
import type {
  Citation,
  DecisionKind,
  DecisionOption,
  DecisionSpec,
  EnquiryReplyFacts,
  Flag,
  IdCheckFacts,
  MortgageOfferFacts,
  SearchFacts,
  Severity,
  SourceLocator,
  TitleFacts,
} from './types';

/** Below this the extraction is not trusted and a human must look at the source. */
export const MIN_EXTRACTION_CONFIDENCE = 0.85;

/** Flags at or above this severity block auto-clear. 'info' is noted, not actioned. */
export const FLAG_SEVERITY_THRESHOLD: Severity = 'low';

const SEVERITY_RANK: Record<Severity, number> = { info: 0, low: 1, medium: 2, high: 3 };
export const severityAtLeast = (s: Severity, floor: Severity): boolean => SEVERITY_RANK[s] >= SEVERITY_RANK[floor];

export type Verdict = { outcome: 'clear'; reasons: string[] } | { outcome: 'flag'; flags: Flag[]; reasons: string[] };

/** The standard option set per decision kind (spec 2.4 step 5). */
export const OPTIONS_FOR: Record<DecisionKind, DecisionOption[]> = {
  id_check: ['approve', 'request_further', 'escalate', 'reject'],
  search: ['approve', 'refer_to_client', 'request_further', 'indemnity', 'escalate'],
  enquiry: ['approve', 'refer_to_client', 'request_further', 'escalate'],
  mortgage: ['approve', 'refer_to_client', 'request_further', 'escalate'],
  title: ['approve', 'refer_to_client', 'request_further', 'indemnity', 'escalate'],
  report_on_title: ['approve', 'reject', 'escalate'],
  escalation: ['approve', 'refer_to_client', 'escalate'],
  // Addendum 2: never "approve" — only an out-of-band VERIFICATION (with its method) or a failure.
  bank_details: ['verify', 'reject', 'escalate'],
  // assist level: confirm the engine's auto-clear was right, or escalate it. Never blocks.
  auto_clear: ['approve', 'escalate'],
  requisition: ['approve', 'escalate'],
  // AML sign-off is a person's act: approve, send the form back for more, escalate, or reject (manual handling).
  proof_of_funds: ['approve', 'request_further', 'escalate', 'reject'],
  management_pack: ['approve', 'refer_to_client', 'request_further', 'escalate'],
  // A note's proposals: apply what the note actually says (approve), throw them away with
  // a reason (reject), or put the note in front of someone senior.
  note_actions: ['approve', 'reject', 'escalate'],
  // PROPOSE level: the engine asked to do something. Yes, or no with a reason.
  proposal: ['approve', 'reject'],
};

const lowConfidenceFlag = (confidence: number, what: string): Flag => ({
  code: 'LOW_EXTRACTION_CONFIDENCE',
  severity: 'medium',
  description: `The ${what} was read with ${Math.round(confidence * 100)}% confidence (threshold ${Math.round(
    MIN_EXTRACTION_CONFIDENCE * 100
  )}%). Check the source document before relying on any of the extracted facts.`,
});

const actionable = (flags: Flag[]): Flag[] => flags.filter((f) => severityAtLeast(f.severity, FLAG_SEVERITY_THRESHOLD));

// ───────────────────────────── Searches ─────────────────────────────

export function evaluateSearch(facts: SearchFacts): Verdict {
  const flags: Flag[] = [];
  if (facts.confidence < MIN_EXTRACTION_CONFIDENCE) flags.push(lowConfidenceFlag(facts.confidence, `${facts.searchType} search`));
  flags.push(...actionable(facts.flags));
  if (flags.length) return { outcome: 'flag', flags, reasons: flags.map((f) => f.code) };
  const info = facts.flags.length ? [`${facts.flags.length} informational entr${facts.flags.length === 1 ? 'y' : 'ies'} noted`] : [];
  return { outcome: 'clear', reasons: ['no actionable flags', `confidence ${facts.confidence.toFixed(2)}`, ...info] };
}

// ───────────────────────────── Enquiry replies ─────────────────────────────

export function evaluateEnquiryReply(facts: EnquiryReplyFacts | null | undefined): Verdict {
  if (!facts) {
    // A reply with no extraction is never auto-cleared: the human reads it.
    return {
      outcome: 'flag',
      flags: [{ code: 'REPLY_NOT_EXTRACTED', severity: 'low', description: 'The reply was received but not read by the extraction pipeline.' }],
      reasons: ['REPLY_NOT_EXTRACTED'],
    };
  }
  const flags: Flag[] = [];
  if (facts.confidence < MIN_EXTRACTION_CONFIDENCE) flags.push(lowConfidenceFlag(facts.confidence, 'reply'));
  if (facts.status !== 'answered') {
    flags.push({
      code: `REPLY_${facts.status.toUpperCase()}`,
      severity: facts.status === 'refused' ? 'high' : 'medium',
      description:
        facts.status === 'partial'
          ? 'The reply only partly answers the enquiry.'
          : facts.status === 'refused'
            ? "The seller's solicitor has declined to answer."
            : 'The reply is unclear or non-committal.',
    });
  }
  flags.push(...actionable(facts.issues));
  if (flags.length) return { outcome: 'flag', flags, reasons: flags.map((f) => f.code) };
  return { outcome: 'clear', reasons: ['answered', 'no issues', `confidence ${facts.confidence.toFixed(2)}`] };
}

// ───────────────────────────── Mortgage offers ─────────────────────────────

/** Days before target exchange within which an offer expiry is a problem worth a human's eye. */
export const OFFER_EXPIRY_WARNING_DAYS = 28;

export function evaluateMortgageOffer(facts: MortgageOfferFacts, targetExchangeDate?: string | null, today?: Date): Verdict {
  const flags: Flag[] = [];
  if (facts.confidence < MIN_EXTRACTION_CONFIDENCE) flags.push(lowConfidenceFlag(facts.confidence, 'mortgage offer'));
  for (const c of facts.conditions) {
    if (!c.standard) {
      flags.push({
        code: `NON_STANDARD_CONDITION:${c.code}`,
        severity: 'medium',
        description: `Special condition ${c.code}: ${c.text}`,
        locator: c.locator,
      });
    }
  }
  if (facts.expiryDate) {
    const expiry = new Date(facts.expiryDate);
    const ref = targetExchangeDate ? new Date(targetExchangeDate) : today ?? null;
    if (ref && !Number.isNaN(expiry.getTime())) {
      const daysLeft = Math.floor((expiry.getTime() - ref.getTime()) / 86_400_000);
      if (daysLeft < 0) {
        flags.push({ code: 'OFFER_EXPIRED', severity: 'high', description: `The offer expired on ${facts.expiryDate}${targetExchangeDate ? ' before the target exchange date' : ''}.` });
      } else if (daysLeft < OFFER_EXPIRY_WARNING_DAYS) {
        flags.push({
          code: 'OFFER_EXPIRY_NEAR',
          severity: 'medium',
          description: `The offer expires on ${facts.expiryDate} — ${daysLeft} day${daysLeft === 1 ? '' : 's'} ${targetExchangeDate ? 'after the target exchange date' : 'from now'}. An extension may be needed.`,
        });
      }
    }
  }
  if (flags.length) return { outcome: 'flag', flags, reasons: flags.map((f) => f.code) };
  return { outcome: 'clear', reasons: [`${facts.conditions.length} standard condition(s)`, `confidence ${facts.confidence.toFixed(2)}`] };
}

// ───────────────────────────── Title register ─────────────────────────────

/** Lender minimums vary (UK Finance Handbook part 2); below these the lease itself is a client-advice point. */
export const SHORT_LEASE_YEARS = { flag: 85, serious: 80 };
/** Ground rent above this (outside London) risks the lease being an assured tenancy; many lenders refuse. */
export const GROUND_RENT_FLAG_PENNIES_PA = 25_000;

export function evaluateTitle(facts: TitleFacts, expectedTenure: 'freehold' | 'leasehold' | 'any' = 'freehold'): Verdict {
  const flags: Flag[] = [];
  if (facts.tenure === 'unknown') {
    flags.push({ code: 'TENURE_UNKNOWN', severity: 'high', description: 'The tenure could not be determined from the register.' });
  } else if (expectedTenure === 'freehold' && facts.tenure === 'leasehold') {
    flags.push({ code: 'TENURE_MISMATCH', severity: 'high', description: 'The title is leasehold but the matter was enrolled as freehold. Re-enrol it as leasehold (management pack, lease review) — automation is paused until then.' });
  } else if (expectedTenure === 'leasehold' && facts.tenure === 'freehold') {
    flags.push({ code: 'TENURE_MISMATCH', severity: 'high', description: 'The title is freehold but the matter was enrolled as leasehold. Check the title number; a share of freehold has a lease as well.' });
  }
  if (facts.tenure === 'leasehold' && expectedTenure !== 'freehold') {
    const l = facts.lease;
    if (!l) flags.push({ code: 'LEASE_NOT_READ', severity: 'medium', description: 'The lease terms (unexpired term, ground rent, review clause) were not extracted. Read the lease before the report on title.' });
    else {
      if (l.unexpiredYears != null && l.unexpiredYears < SHORT_LEASE_YEARS.flag) {
        flags.push({ code: 'SHORT_LEASE', severity: l.unexpiredYears < SHORT_LEASE_YEARS.serious ? 'high' : 'medium', description: `${l.unexpiredYears} years unexpired${l.unexpiredYears < SHORT_LEASE_YEARS.serious ? ' — below 80, marriage value applies to an extension and many lenders will not lend' : ' — near the point lenders and buyers start to discount'}.`, locator: l.locator });
      }
      if (l.groundRentPenniesPa != null && l.groundRentPenniesPa > GROUND_RENT_FLAG_PENNIES_PA) {
        flags.push({ code: 'GROUND_RENT_HIGH', severity: 'medium', description: `Ground rent £${(l.groundRentPenniesPa / 100).toLocaleString('en-GB')} a year exceeds the assured-tenancy threshold; lender acceptability must be checked.`, locator: l.locator });
      }
      if (l.groundRentReview && /doubl|x\s?2|twice|compound/i.test(l.groundRentReview)) {
        flags.push({ code: 'GROUND_RENT_DOUBLING', severity: 'high', description: `Ground rent review clause: "${l.groundRentReview}". Doubling rents are refused by many lenders; a deed of variation may be needed.`, locator: l.locator });
      }
    }
  }
  if (facts.confidence < MIN_EXTRACTION_CONFIDENCE) flags.push(lowConfidenceFlag(facts.confidence, 'title register'));
  for (const r of facts.restrictions) {
    flags.push({ code: `RESTRICTION:${r.code}`, severity: 'medium', description: `Restriction (${r.register ?? 'B'} register): ${r.text}`, locator: r.locator });
  }
  for (const c of facts.charges) {
    // A registered charge must be discharged on completion (DS1 / undertaking) — always a human check.
    flags.push({ code: `CHARGE:${c.code}`, severity: 'medium', description: `Registered charge: ${c.text}. An undertaking to discharge on completion is required.`, locator: c.locator });
  }
  for (const c of facts.covenants) {
    flags.push({ code: `COVENANT:${c.code}`, severity: 'low', description: `Covenant: ${c.text}`, locator: c.locator });
  }
  if (flags.length) return { outcome: 'flag', flags, reasons: flags.map((f) => f.code) };
  return { outcome: 'clear', reasons: ['freehold', 'no restrictions, charges or covenants', `confidence ${facts.confidence.toFixed(2)}`] };
}

// ───────────────────────────── ID / AML ─────────────────────────────

export function evaluateIdCheck(facts: IdCheckFacts): Verdict {
  const flags: Flag[] = [];
  if (facts.confidence < MIN_EXTRACTION_CONFIDENCE) flags.push(lowConfidenceFlag(facts.confidence, 'ID check result'));
  if (facts.outcome !== 'clear') {
    flags.push({
      code: `ID_${facts.outcome.toUpperCase()}`,
      severity: facts.outcome === 'fail' ? 'high' : 'medium',
      description: facts.outcome === 'fail' ? `${facts.provider} reported a failed identity/AML check.` : `${facts.provider} referred the identity/AML check for manual review.`,
    });
  }
  flags.push(...actionable(facts.flags));
  if (flags.length) return { outcome: 'flag', flags, reasons: flags.map((f) => f.code) };
  return { outcome: 'clear', reasons: [`${facts.provider}: clear`, `confidence ${facts.confidence.toFixed(2)}`] };
}

// ───────────────────────────── Deterministic summaries ─────────────────────────────

/**
 * "What this usually means" for the common flag codes. Keyed by the code prefix so
 * `RESTRICTION:XYZ` and `NON_STANDARD_CONDITION:ABC` share an explanation. This is the
 * bit the spec calls "AI-drafted plain-English explanation of the flag(s), what they
 * typically mean, standard options" — done deterministically first, with the AI port
 * able to improve the prose without changing the facts.
 */
const MEANINGS: Array<[RegExp, string]> = [
  [/^LOW_EXTRACTION_CONFIDENCE$/, 'The document was hard to read automatically; nothing extracted from it should be relied on without checking the original.'],
  [/^LEASEHOLD_UNSUPPORTED$/, 'This version only automates freehold purchases. Take the matter through the manual process.'],
  [/^RESTRICTION:/, 'A restriction on the proprietorship register limits how the property can be dealt with — typically a consent or certificate will be needed before the transfer can be registered.'],
  [/^CHARGE:/, 'A charge means a lender holds security over the property; the seller must discharge it on completion and their solicitor should give an undertaking to do so.'],
  [/^COVENANT:/, 'Covenants bind the buyer after purchase; they are usually acceptable but the client must be told about them in the report on title.'],
  [/^NON_STANDARD_CONDITION:/, 'A special condition in the mortgage offer must be satisfied before the lender releases funds — check what evidence is needed and by when.'],
  [/^OFFER_EXPIR/, 'Mortgage offers lapse; if exchange or completion will fall after expiry an extension must be requested from the lender in good time.'],
  [/^REPLY_/, 'An unsatisfactory reply usually means a further enquiry, or a decision that the point is acceptable to the client.'],
  [/^ID_/, 'The client cannot proceed until identity and source-of-funds checks are satisfactory; a referred check may only need additional documents.'],
  [/^CON29|^LLC1|^PLANNING|^ROAD|^DRAIN|^FLOOD|^CONTAM|^RADON/, 'A search result flag is a matter to raise with the seller, report to the client, or cover with a further search or indemnity policy — depending on severity.'],
];

const meaningFor = (code: string): string | null => MEANINGS.find(([re]) => re.test(code))?.[1] ?? null;

const locatorLabel = (l?: SourceLocator): string => {
  if (!l) return 'source document';
  const parts: string[] = [];
  if (l.page) parts.push(`p.${l.page}`);
  if (l.section) parts.push(l.section);
  return parts.length ? parts.join(', ') : 'source document';
};

/** Build citations (one per flag, falling back to the document as a whole) for a decision. */
export function citationsFor(sourceDocumentId: string, flags: Flag[], fallbackLabel: string): Citation[] {
  const cites = flags.filter((f) => f.locator).map((f) => ({ documentId: sourceDocumentId, locator: f.locator, label: `${f.code} — ${locatorLabel(f.locator)}` }));
  return cites.length ? cites : [{ documentId: sourceDocumentId, label: fallbackLabel }];
}

/** Deterministic, source-citing plain-English summary of a flagged verdict. */
export function templateSummary(kind: DecisionKind, subjectLabel: string, flags: Flag[]): string {
  const lines: string[] = [`${subjectLabel}: ${flags.length} item${flags.length === 1 ? '' : 's'} need${flags.length === 1 ? 's' : ''} a decision.`];
  const seenMeanings = new Set<string>();
  flags.forEach((f, i) => {
    lines.push(`${i + 1}. [${f.severity.toUpperCase()}] ${f.description} (see ${locatorLabel(f.locator)})`);
    const m = meaningFor(f.code);
    if (m && !seenMeanings.has(m)) {
      seenMeanings.add(m);
      lines.push(`   What this usually means: ${m}`);
    }
  });
  lines.push(`Options: ${OPTIONS_FOR[kind].map(optionLabel).join(' · ')}.`);
  return lines.join('\n');
}

export function optionLabel(o: DecisionOption): string {
  switch (o) {
    case 'approve':
      return 'approve — proceed as standard';
    case 'refer_to_client':
      return 'refer to client';
    case 'request_further':
      return 'request further search/enquiry';
    case 'escalate':
      return 'escalate to senior';
    case 'reject':
      return 'reject';
    case 'verify':
      return 'verified out-of-band (method required)';
    case 'indemnity':
      return 'cover with an indemnity policy';
  }
}

/** Assemble a complete DecisionSpec from a flag verdict. The machine validates it. */
export function buildDecision(input: {
  kind: DecisionKind;
  subjectLabel: string;
  flags: Flag[];
  sourceDocumentId: string;
  summary?: { text: string; by: string } | null;
}): DecisionSpec {
  const citations = citationsFor(input.sourceDocumentId, input.flags, `${input.subjectLabel} — full document`);
  const first = input.flags.find((f) => f.locator)?.locator;
  return {
    kind: input.kind,
    summary: input.summary?.text ?? templateSummary(input.kind, input.subjectLabel, input.flags),
    sourceDocumentId: input.sourceDocumentId,
    sourceLocator: first,
    citations,
    options: OPTIONS_FOR[input.kind],
    summarisedBy: input.summary?.by ?? 'template',
  };
}
