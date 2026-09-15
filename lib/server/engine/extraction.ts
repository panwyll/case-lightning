/**
 * Component #2 — document ingestion + extraction pipeline.
 *
 *   raw PDF / scan / image / text
 *     → classify (what is this? which sub-flow does it belong to?)
 *     → extract (typed facts with a per-field confidence and a page/quote locator)
 *     → normalise (deterministic: codes, severities, confidence floor)
 *     → persist on document.extracted_facts (+ extraction_confidence)
 *     → hand to the engine (service.ts), whose RULE layer decides clear vs flag
 *
 * Design rules:
 *   - Confidence is a first-class output. The overall confidence is the MINIMUM of the
 *     model's document-level confidence and every flag's own confidence, so one shaky
 *     field drags the whole extraction under the threshold and to a human.
 *   - Every flag carries a locator (page + quote). The decision the handler sees cites
 *     it; the rubber-stamp guard depends on it.
 *   - Variable-quality scans are the norm: the model is told to lower confidence on
 *     illegible pages rather than fill gaps, and a failed call becomes confidence 0.
 *   - The model never decides severity policy alone: severities it proposes are
 *     clamped by a code→minimum-severity table so a known-serious code can't be
 *     downgraded to "info" by a lenient read.
 */
import crypto from 'node:crypto';
import { z } from 'zod/v4';
import type { EnquiryReplyFacts, Flag, IdCheckFacts, MortgageOfferFacts, SearchFacts, SearchType, Severity, TitleFacts } from './types';
import { SEARCH_TYPES } from './types';
import type { DocumentExtractor, DocumentRef } from './ports';
import { ENGINE_SYSTEM_GUARD, type EngineDocumentInput, type StructuredLlm } from './llm';
import { MIN_EXTRACTION_CONFIDENCE } from './rules';

// ───────────────────────────── schemas (what the model must return) ─────────────────────────────

const conf = z.number().min(0).max(1).describe('0–1 confidence that this value is exactly right. Lower it for illegible scans, partial pages or inference.');
const locator = z.object({
  page: z.number().int().min(1).describe('1-based page number the fact appears on.'),
  section: z.string().describe('Section / question / register heading, e.g. "3.7", "C: Charges register", "Special condition 4". Empty string if none.'),
  quote: z.string().describe('Short verbatim quote (≤ 200 chars) of the text relied on.'),
});
const severity = z.enum(['info', 'low', 'medium', 'high']);

const flagSchema = z.object({
  code: z.string().describe('UPPER_SNAKE_CASE code from the taxonomy in the instructions, or a new one in the same style.'),
  severity,
  description: z.string().describe('One plain-English sentence stating the finding as a fact (no advice).'),
  locator,
  confidence: conf,
});

export const ClassificationSchema = z.object({
  role: z.enum(['search', 'enquiry_reply', 'mortgage_offer', 'title', 'id_check', 'contract', 'other']),
  searchType: z.enum([...SEARCH_TYPES, 'NONE']).describe('Only when role = search.'),
  enquiryReferences: z.array(z.string()).describe('Enquiry numbers/identifiers the document replies to (e.g. "E1", "3", "Additional enquiry 2"), when role = enquiry_reply.'),
  titleNumber: z.string().describe('Land Registry title number if visible, else empty string.'),
  lender: z.string().describe('Lender name if this is a mortgage offer, else empty string.'),
  scanQuality: z.enum(['good', 'fair', 'poor', 'unreadable']),
  pageCount: z.number().int().min(0),
  confidence: conf,
  reason: z.string().describe('One sentence: what in the document tells you this.'),
});
export type Classification = z.infer<typeof ClassificationSchema>;

export const SearchExtractionSchema = z.object({
  searchType: z.enum(SEARCH_TYPES),
  provider: z.string(),
  searchDate: z.string().describe('ISO date the search was compiled, or empty string.'),
  propertyAddressAsSearched: z.string(),
  flags: z.array(flagSchema).describe('Every adverse or notable entry. Use severity "info" for routine entries (adopted road, no entries) so the handler sees they were checked.'),
  summaryFields: z.array(z.object({ label: z.string(), value: z.string(), locator })).describe('Headline facts a conveyancer expects (e.g. planning history count, road status, drainage connection).'),
  scanQuality: z.enum(['good', 'fair', 'poor', 'unreadable']),
  confidence: conf.describe('Document-level confidence that nothing material was missed.'),
});

export const EnquiryReplyExtractionSchema = z.object({
  replies: z.array(
    z.object({
      enquiryReference: z.string().describe('The enquiry number/identifier as written in the reply.'),
      status: z.enum(['answered', 'partial', 'refused', 'unclear']),
      replyText: z.string().describe('Verbatim reply (≤ 600 chars).'),
      issues: z.array(flagSchema),
      locator,
      confidence: conf,
    })
  ),
  scanQuality: z.enum(['good', 'fair', 'poor', 'unreadable']),
  confidence: conf,
});

export const MortgageOfferExtractionSchema = z.object({
  lender: z.string(),
  borrowerNames: z.array(z.string()),
  propertyAddress: z.string(),
  amountPennies: z.number().int().min(0).describe('Loan amount in pennies; 0 if not stated.'),
  expiryDate: z.string().describe('ISO date the offer expires, or empty string.'),
  conditions: z.array(
    z.object({
      code: z.string().describe('The offer\'s own condition reference, e.g. "SC4" or "General condition 12".'),
      text: z.string().describe('Verbatim condition (≤ 500 chars).'),
      standard: z.boolean().describe('true ONLY for the lender\'s boilerplate general conditions; false for any special/specific condition, retention, occupier consent, or evidence request.'),
      locator,
      confidence: conf,
    })
  ),
  scanQuality: z.enum(['good', 'fair', 'poor', 'unreadable']),
  confidence: conf,
});

const titleEntry = z.object({
  code: z.string().describe('Entry number as printed, e.g. "B2", "C1".'),
  text: z.string().describe('Verbatim entry (≤ 600 chars).'),
  register: z.enum(['A', 'B', 'C']),
  locator,
  confidence: conf,
});
export const TitleExtractionSchema = z.object({
  titleNumber: z.string(),
  tenure: z.enum(['freehold', 'leasehold', 'unknown']),
  editionDate: z.string().describe('Edition/official copy date, ISO or empty.'),
  registeredProprietors: z.array(z.string()),
  propertyDescription: z.string(),
  restrictions: z.array(titleEntry),
  charges: z.array(titleEntry),
  covenants: z.array(titleEntry).describe('Restrictive or positive covenants, easements and rights that bind or benefit the land.'),
  scanQuality: z.enum(['good', 'fair', 'poor', 'unreadable']),
  confidence: conf,
});

export const IdCheckExtractionSchema = z.object({
  provider: z.string(),
  subjectNames: z.array(z.string()),
  outcome: z.enum(['clear', 'refer', 'fail']),
  checkDate: z.string(),
  flags: z.array(flagSchema).describe('PEP/sanctions matches, address mismatches, document failures.'),
  scanQuality: z.enum(['good', 'fair', 'poor', 'unreadable']),
  confidence: conf,
});

// ───────────────────────────── taxonomy + normalisation (deterministic) ─────────────────────────────

/** Known codes and the LOWEST severity they may be reported at. The model may raise, never lower. */
export const MIN_SEVERITY: Record<string, Severity> = {
  PLANNING_ENFORCEMENT: 'high',
  BREACH_OF_CONDITION: 'high',
  CONTAMINATED_LAND: 'high',
  FLOOD_RISK_HIGH: 'high',
  COMPULSORY_PURCHASE: 'high',
  LISTED_BUILDING: 'medium',
  CONSERVATION_AREA: 'low',
  TREE_PRESERVATION_ORDER: 'low',
  ARTICLE_4_DIRECTION: 'medium',
  ROAD_UNADOPTED: 'medium',
  ROAD_PROPOSALS: 'medium',
  CIL_LIABILITY: 'medium',
  FINANCIAL_CHARGE: 'medium',
  DRAINAGE_NOT_CONNECTED: 'medium',
  BUILD_OVER_AGREEMENT: 'medium',
  PUBLIC_SEWER_WITHIN_3M: 'low',
  FLOOD_RISK_MEDIUM: 'medium',
  FLOOD_RISK_LOW: 'low',
  RADON_AFFECTED: 'low',
  MINING_AREA: 'medium',
  CHANCEL_LIABILITY: 'medium',
  PEP_MATCH: 'medium',
  SANCTIONS_MATCH: 'high',
  ADDRESS_MISMATCH: 'medium',
  DOCUMENT_FAILED: 'high',
};

const SEV_RANK: Record<Severity, number> = { info: 0, low: 1, medium: 2, high: 3 };
const maxSeverity = (a: Severity, b: Severity): Severity => (SEV_RANK[a] >= SEV_RANK[b] ? a : b);

export const normaliseCode = (code: string): string =>
  code
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'UNSPECIFIED';

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/** Scan quality caps confidence: a "poor" scan can never be read with 0.95 certainty. */
const QUALITY_CAP: Record<'good' | 'fair' | 'poor' | 'unreadable', number> = { good: 1, fair: 0.9, poor: 0.6, unreadable: 0 };

type RawFlag = z.infer<typeof flagSchema>;

export function normaliseFlags(raw: RawFlag[]): { flags: Flag[]; minConfidence: number } {
  let min = 1;
  const flags = raw.map((f) => {
    const code = normaliseCode(f.code);
    const sev = maxSeverity(f.severity, MIN_SEVERITY[code] ?? 'info');
    min = Math.min(min, clamp01(f.confidence));
    return { code, severity: sev, description: f.description.trim(), locator: { page: f.locator.page, section: f.locator.section || undefined, quote: f.locator.quote || undefined } };
  });
  return { flags, minConfidence: min };
}

/** Overall confidence = min(document confidence, every item's confidence), capped by scan quality. */
export function overallConfidence(docConfidence: number, itemConfidences: number[], scanQuality: keyof typeof QUALITY_CAP): number {
  const floor = Math.min(clamp01(docConfidence), ...itemConfidences.map(clamp01));
  return Math.min(floor, QUALITY_CAP[scanQuality]);
}

export function toSearchFacts(out: z.infer<typeof SearchExtractionSchema>, expected: SearchType): SearchFacts {
  const { flags, minConfidence } = normaliseFlags(out.flags);
  const summaryFields: Record<string, string> = {};
  for (const f of out.summaryFields) summaryFields[f.label] = f.value;
  const mismatch = out.searchType !== expected;
  if (mismatch) {
    flags.push({ code: 'SEARCH_TYPE_MISMATCH', severity: 'medium', description: `Document reads as a ${out.searchType} search but a ${expected} search was expected.`, locator: { page: 1 } });
  }
  return { searchType: expected, flags, confidence: overallConfidence(out.confidence, [minConfidence], out.scanQuality), summaryFields };
}

export function toEnquiryReplyFacts(out: z.infer<typeof EnquiryReplyExtractionSchema>, enquiryId: string): EnquiryReplyFacts | null {
  const match = out.replies.find((r) => referencesMatch(r.enquiryReference, enquiryId)) ?? (out.replies.length === 1 ? out.replies[0] : null);
  if (!match) return null;
  const { flags, minConfidence } = normaliseFlags(match.issues);
  return { enquiryId, status: match.status, issues: flags, confidence: overallConfidence(out.confidence, [match.confidence, minConfidence], out.scanQuality) };
}

/** "E1" ≈ "1" ≈ "Enquiry 1" ≈ "e1", but "E1" ≠ "E11" and "E2" ≠ "E2-F1" (a follow-up is its own enquiry). */
const GENERIC_PREFIXES = new Set(['', 'E', 'ENQ', 'ENQUIRY', 'ENQUIRIES', 'Q', 'QUESTION', 'ADDITIONAL', 'ADDITIONALENQUIRY', 'NO', 'NUMBER', 'ITEM', 'REPLY', 'REPLYTO']);
export function referencesMatch(a: string, b: string): boolean {
  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, '');
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const digits = (s: string) => s.replace(/[^0-9]/g, '');
  const letters = (s: string) => s.replace(/[^A-Z]/g, '');
  if (!digits(na) || digits(na) !== digits(nb)) return false;
  const la = letters(na);
  const lb = letters(nb);
  return la === lb || GENERIC_PREFIXES.has(la) || GENERIC_PREFIXES.has(lb);
}

export function toMortgageFacts(out: z.infer<typeof MortgageOfferExtractionSchema>): MortgageOfferFacts {
  const conditions = out.conditions.map((c) => ({ code: normaliseCode(c.code), text: c.text.trim(), standard: c.standard, locator: { page: c.locator.page, section: c.locator.section || undefined, quote: c.locator.quote || undefined } }));
  return {
    lender: out.lender.trim() || 'unknown lender',
    amountPennies: out.amountPennies || undefined,
    expiryDate: out.expiryDate || undefined,
    conditions,
    confidence: overallConfidence(out.confidence, out.conditions.map((c) => c.confidence), out.scanQuality),
  };
}

export function toTitleFacts(out: z.infer<typeof TitleExtractionSchema>): TitleFacts {
  const entry = (e: z.infer<typeof titleEntry>) => ({ code: normaliseCode(e.code), text: e.text.trim(), register: e.register, locator: { page: e.locator.page, section: e.locator.section || undefined, quote: e.locator.quote || undefined } });
  const all = [...out.restrictions, ...out.charges, ...out.covenants];
  return {
    titleNumber: out.titleNumber.trim().toUpperCase() || 'UNKNOWN',
    tenure: out.tenure,
    restrictions: out.restrictions.map(entry),
    charges: out.charges.map(entry),
    covenants: out.covenants.map(entry),
    confidence: overallConfidence(out.confidence, all.map((e) => e.confidence), out.scanQuality),
  };
}

export function toIdCheckFacts(out: z.infer<typeof IdCheckExtractionSchema>): IdCheckFacts {
  const { flags, minConfidence } = normaliseFlags(out.flags);
  return { provider: out.provider.trim() || 'unknown', outcome: out.outcome, flags, confidence: overallConfidence(out.confidence, [minConfidence], out.scanQuality) };
}

// ───────────────────────────── prompts ─────────────────────────────

const TAXONOMY =
  'Flag code taxonomy (use these where they fit; invent UPPER_SNAKE codes only for genuinely new findings): ' +
  Object.keys(MIN_SEVERITY).join(', ') +
  '. Severity guide: high = would normally stop or reprice the purchase or needs urgent action (enforcement, contamination, sanctions); ' +
  'medium = needs a decision, further enquiry or indemnity before exchange; low = must be reported to the client but is usually acceptable; ' +
  'info = routine confirmation worth recording (road adopted, no entries).';

const SCAN_NOTE =
  'The document may be a scan of variable quality. Read every page. Where a page is illegible or partially legible, ' +
  'report what you can, set scanQuality accordingly and LOWER the confidence of anything you had to infer. Never fill a gap with a plausible value.';

const PROMPTS = {
  classify: `Classify this conveyancing document. Decide which engine sub-flow it belongs to: a search result (LLC1 local land charges, CON29 local authority enquiries, drainage & water, environmental, chancel), replies to enquiries from the seller's solicitor, a mortgage offer, an official copy of the register of title (HM Land Registry), an ID/AML check report, a contract/transfer, or other. ${SCAN_NOTE}`,
  search: `Extract the findings of this property search as typed facts. ${TAXONOMY} Include informational entries so the handler can see what was checked. ${SCAN_NOTE}`,
  enquiry: `Extract the seller's solicitor's replies to pre-contract enquiries. For each reply, decide whether it fully answers the question ("answered"), only partly ("partial"), declines ("refused" — e.g. "the buyer must rely on their own survey/searches" where a factual answer was asked), or is unclear. Record any issue the reply reveals as a flag. ${TAXONOMY} ${SCAN_NOTE}`,
  mortgage: `Extract the terms and conditions of this mortgage offer. Mark a condition as standard ONLY if it is boilerplate that appears in every offer from this lender (general conditions); anything specific to this borrower or property — retentions, repairs, occupier consents, evidence of deposit source, valuation conditions, lease requirements — is NOT standard. ${SCAN_NOTE}`,
  title: `Extract the register of title. Capture every entry from the proprietorship (B) and charges (C) registers verbatim, and every covenant, easement or right from the property (A) register. Tenure must be read from the register heading. ${SCAN_NOTE}`,
  idCheck: `Extract the outcome of this identity / anti-money-laundering check report. Record any PEP, sanctions, adverse media, address or document flags. ${SCAN_NOTE}`,
};

// ───────────────────────────── loading document bytes ─────────────────────────────

export interface DocumentBytesLoader {
  /** The document as the model should see it, or null when nothing readable exists. */
  load(doc: DocumentRef): Promise<EngineDocumentInput | null>;
}

export interface DocumentFactsWriter {
  /** Persist extraction output on the document (document.extracted_facts) for reuse and audit. */
  write(doc: DocumentRef, facts: unknown, confidence: number, meta: { role: string; model: string; promptHash: string; contentHash: string }): Promise<void>;
}

/** Facts already persisted by a previous run of THIS pipeline (not a hand-seeded fixture). */
interface PersistedFacts {
  _pipeline?: { role: string; contentHash: string; model: string; promptHash: string; at: string };
  facts?: unknown;
}

// ───────────────────────────── the extractor ─────────────────────────────

export class ClaudeExtractor implements DocumentExtractor {
  readonly name: string;

  constructor(
    private llm: StructuredLlm,
    private loader: DocumentBytesLoader,
    private writer: DocumentFactsWriter | null,
    private opts: { model: string; effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' } = { model: 'claude-opus-5', effort: 'high' }
  ) {
    this.name = `claude-extractor:${opts.model}`;
  }

  private async input(doc: DocumentRef): Promise<{ input: EngineDocumentInput; contentHash: string }> {
    const input = await this.loader.load(doc);
    if (!input) throw new Error(`Document ${doc.id} has no readable content.`);
    const contentHash = crypto.createHash('sha256').update(input.data).digest('hex');
    return { input, contentHash };
  }

  private cached<T>(doc: DocumentRef, role: string, contentHash: string): T | null {
    const p = doc.extractedFacts as PersistedFacts | null;
    if (p?._pipeline && p._pipeline.role === role && p._pipeline.contentHash === contentHash && p.facts) return p.facts as T;
    return null;
  }

  private async run<S extends z.ZodType>(doc: DocumentRef, role: string, schema: S, instructions: string, prompt: string, feature: 'DOC_CLASSIFY' | 'DOC_EXTRACT') {
    const { input, contentHash } = await this.input(doc);
    const res = await this.llm.call<z.infer<S>>({
      schema: schema as unknown as z.ZodType<z.infer<S>>,
      instructions,
      documents: [{ ...input, title: doc.fileName ?? doc.id }],
      prompt,
      model: this.opts.model,
      effort: this.opts.effort ?? 'high',
      meter: { tenantId: doc.tenantId, matterId: doc.matterId, feature },
    });
    return { out: res.output, contentHash, model: res.model, promptHash: res.promptHash };
  }

  private async persist(doc: DocumentRef, role: string, facts: unknown, confidence: number, meta: { model: string; promptHash: string; contentHash: string }) {
    if (!this.writer) return;
    await this.writer.write(doc, { _pipeline: { role, ...meta, at: new Date().toISOString() }, facts }, confidence, { role, ...meta }).catch(() => {});
  }

  async classify(doc: DocumentRef): Promise<Classification> {
    const { out } = await this.run(doc, 'classify', ClassificationSchema, PROMPTS.classify, `File name: ${doc.fileName ?? 'unknown'}. Classify the document.`, 'DOC_CLASSIFY');
    return out;
  }

  async extractSearch(doc: DocumentRef, searchType: SearchType): Promise<SearchFacts> {
    const { contentHash } = await this.input(doc);
    const hit = this.cached<SearchFacts>(doc, `search:${searchType}`, contentHash);
    if (hit) return hit;
    const { out, model, promptHash } = await this.run(doc, 'search', SearchExtractionSchema, PROMPTS.search, `Expected search type: ${searchType}. Extract this search result.`, 'DOC_EXTRACT');
    const facts = toSearchFacts(out, searchType);
    await this.persist(doc, `search:${searchType}`, facts, facts.confidence, { model, promptHash, contentHash });
    return facts;
  }

  async extractEnquiryReply(doc: DocumentRef, enquiryId: string): Promise<EnquiryReplyFacts | null> {
    const { contentHash } = await this.input(doc);
    const hit = this.cached<EnquiryReplyFacts>(doc, `enquiry:${enquiryId}`, contentHash);
    if (hit) return hit;
    const { out, model, promptHash } = await this.run(doc, 'enquiry', EnquiryReplyExtractionSchema, PROMPTS.enquiry, `We raised enquiry "${enquiryId}". Extract every reply in the document; the engine will match the one for "${enquiryId}".`, 'DOC_EXTRACT');
    const facts = toEnquiryReplyFacts(out, enquiryId);
    if (facts) await this.persist(doc, `enquiry:${enquiryId}`, facts, facts.confidence, { model, promptHash, contentHash });
    return facts;
  }

  async extractMortgageOffer(doc: DocumentRef): Promise<MortgageOfferFacts> {
    const { contentHash } = await this.input(doc);
    const hit = this.cached<MortgageOfferFacts>(doc, 'mortgage', contentHash);
    if (hit) return hit;
    const { out, model, promptHash } = await this.run(doc, 'mortgage', MortgageOfferExtractionSchema, PROMPTS.mortgage, 'Extract this mortgage offer.', 'DOC_EXTRACT');
    const facts = toMortgageFacts(out);
    await this.persist(doc, 'mortgage', facts, facts.confidence, { model, promptHash, contentHash });
    return facts;
  }

  async extractTitle(doc: DocumentRef): Promise<TitleFacts> {
    const { contentHash } = await this.input(doc);
    const hit = this.cached<TitleFacts>(doc, 'title', contentHash);
    if (hit) return hit;
    const { out, model, promptHash } = await this.run(doc, 'title', TitleExtractionSchema, PROMPTS.title, 'Extract this register of title.', 'DOC_EXTRACT');
    const facts = toTitleFacts(out);
    await this.persist(doc, 'title', facts, facts.confidence, { model, promptHash, contentHash });
    return facts;
  }

  async extractIdCheck(doc: DocumentRef): Promise<IdCheckFacts> {
    const { contentHash } = await this.input(doc);
    const hit = this.cached<IdCheckFacts>(doc, 'id_check', contentHash);
    if (hit) return hit;
    const { out, model, promptHash } = await this.run(doc, 'id_check', IdCheckExtractionSchema, PROMPTS.idCheck, 'Extract this ID/AML check report.', 'DOC_EXTRACT');
    const facts = toIdCheckFacts(out);
    await this.persist(doc, 'id_check', facts, facts.confidence, { model, promptHash, contentHash });
    return facts;
  }
}

/** The pipeline's own threshold, re-exported so callers can reason about "will this auto-clear?". */
export { MIN_EXTRACTION_CONFIDENCE, ENGINE_SYSTEM_GUARD };
