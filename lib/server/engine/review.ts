/**
 * Document review, part 1 and 2 of docs/… (the Document Review Engine design):
 *
 *   coverage ledger — one verdict per page (facts found, read and nothing relevant,
 *                     unreadable, or unattested when the model returned no verdict), so
 *                     "was every page read?" is a row count, not an assumption;
 *   fact register   — every typed fact the extractor produced, flattened to one row
 *                     (key, value, page, verbatim quote) and VERIFIED by finding the quote
 *                     in the page's own text after extraction. A quote that cannot be
 *                     found is not a fact; it is a question, and it says so.
 *
 * Pure functions here; pdf.js is loaded lazily by `pdfPageTexts` so nothing else pays for it.
 */
import { z } from 'zod/v4';
import type { ContractFacts, EnquiryReplyFacts, Flag, IdCheckFacts, MortgageOfferFacts, SearchFacts, TitleFacts, LeaseFacts, ManagementPackFacts, PropertyFormsFacts, SupportingDocFacts, TitlePlanFacts, SurveyFacts } from './types';

export type PageVerdict = 'facts' | 'nothing' | 'unreadable' | 'unattested';

export interface PageRow { page: number; verdict: PageVerdict; textChars: number; /** OCR confidence 0–100 when the page text came from OCR */ ocr?: number | null }
export interface FactRow {
  key: string;
  value: string;
  page: number | null;
  quote: string | null;
  confidence: number | null;
  verified: boolean;
  /** Why it is not verified: no quote, no text layer, quote not on the page, quote not in the document. */
  note: string | null;
}
export interface DocumentReview {
  role: string;
  pages: PageRow[];
  facts: FactRow[];
  summary: { pages: number; read: number; withFacts: number; unreadable: number; unattested: number; complete: boolean; facts: number; verified: number; textLayer: boolean };
}

/** The ledger the model must return alongside its facts: one verdict for every page it was given. */
export const PageLedgerSchema = z
  .array(z.object({ page: z.number().int().min(1), verdict: z.enum(['facts', 'nothing', 'unreadable']) }))
  .describe('One entry for EVERY page of the document, in order: "facts" if you took a fact or flag from it, "nothing" if you read it and it holds nothing relevant, "unreadable" if you could not read it. Never skip a page.');
export type PageLedger = z.infer<typeof PageLedgerSchema>;

export interface PageTexts { pages: string[]; textLayer: boolean; /** per page, OCR confidence when that page's text came from OCR */ ocr?: Array<number | null> }

type TextItem = { str: string; x: number; y: number; w: number; h: number; eol: boolean };

/**
 * One page's text items as lines, in reading order, with a table's cells kept apart: items on the same
 * baseline make a line; a wide gap between two of them (a column) becomes " | ", so a statement row reads
 * "02/09 | Salary | 2,450.00" and a schedule row stays one row. Pure, for the tests.
 */
export function layoutLines(items: TextItem[]): string {
  const live = items.filter((i) => i.str.trim() || i.eol);
  if (!live.length) return '';
  // Top to bottom (PDF y grows upwards), then left to right; a line is items within half a line height of each other.
  const sorted = live.slice().sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: TextItem[][] = [];
  for (const it of sorted) {
    const line = lines[lines.length - 1];
    const ref = line?.[0];
    if (line && Math.abs(ref.y - it.y) <= Math.max(2, Math.min(ref.h || 10, it.h || 10) * 0.5)) line.push(it);
    else lines.push([it]);
  }
  return lines.map((line) => {
    const row = line.filter((i) => i.str.trim()).sort((a, b) => a.x - b.x);
    let s = '';
    let end = -Infinity;
    for (const it of row) {
      const size = it.h || 10;
      const gap = it.x - end;
      s += !s ? it.str : gap > size * 0.8 ? ` | ${it.str}` : gap > size * 0.15 && !/\s$/.test(s) && !/^\s/.test(it.str) ? ` ${it.str}` : it.str;
      end = it.x + it.w;
    }
    return s.replace(/[ \t]{2,}/g, ' ').trim();
  }).filter(Boolean).join('\n');
}

/** Per-page text of a PDF through pdf.js, laid out as lines (tables as rows); an image or a scan without a text layer yields empty pages. */
export async function pdfPageTexts(bytes: Buffer): Promise<PageTexts> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const items: TextItem[] = content.items.flatMap((it) => ('str' in it ? [{ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width, h: it.height || Math.abs(it.transform[3]) || 10, eol: !!it.hasEOL }] : []));
    pages.push(layoutLines(items));
  }
  await (doc as unknown as { cleanup?: () => Promise<void> }).cleanup?.().catch(() => {});
  return { pages, textLayer: pages.some((p) => p.replace(/\s+/g, '').length > 20) };
}

const thin = (s: string) => s.replace(/\s+/g, '').length <= 20;

/**
 * Page text with OCR where the text layer is missing: every page of a PDF that carries no
 * usable text is rendered and read; an image is read whole. The result says which pages
 * came from OCR and how confident the OCR was, so a poor scan reads as poor, not as blank.
 */
export async function pageTextsWithOcr(input: { kind: 'pdf' | 'image' | 'text'; data: string }, opts: { ocr?: boolean } = {}): Promise<PageTexts> {
  if (input.kind === 'text') return { pages: [input.data], textLayer: true };
  const { ocrImage, ocrPdfPages } = await import('./ocr');
  if (input.kind === 'image') {
    if (opts.ocr === false) return { pages: [], textLayer: false };
    try {
      const r = await ocrImage(Buffer.from(input.data, 'base64'));
      return { pages: [r.text], textLayer: !thin(r.text), ocr: [r.confidence] };
    } catch {
      return { pages: [], textLayer: false };
    }
  }
  const bytes = Buffer.from(input.data, 'base64');
  const base = await pdfPageTexts(bytes).catch(() => ({ pages: [] as string[], textLayer: false }));
  if (opts.ocr === false) return base;
  const missing = base.pages.map((s, i) => (thin(s) ? i + 1 : 0)).filter(Boolean);
  if (!missing.length) return base;
  const read = await ocrPdfPages(bytes, missing).catch(() => new Map());
  const pages = base.pages.slice();
  const ocr: Array<number | null> = base.pages.map(() => null);
  for (const [p, r] of read) { pages[p - 1] = r.text; ocr[p - 1] = r.confidence; }
  return { pages, textLayer: pages.some((s) => !thin(s)), ocr };
}

const norm = (s: string) => s.toLowerCase().replace(/[‘’“”]/g, "'").replace(/[^a-z0-9£$%.,;:/()'-]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Is the quote in the page's text? Whitespace, case and quote marks are forgiven; words are not. */
export function verifyQuote(quote: string | null | undefined, page: number | null, texts: PageTexts): { verified: boolean; note: string | null } {
  if (!quote || !quote.trim()) return { verified: false, note: 'no quote' };
  if (!texts.textLayer) return { verified: false, note: 'no text layer to check against' };
  const ocrConf = page != null ? texts.ocr?.[page - 1] ?? null : null;
  const q = norm(quote);
  if (q.length < 6) return { verified: false, note: 'quote too short to check' };
  const onPage = page != null && texts.pages[page - 1] ? norm(texts.pages[page - 1]).includes(q) : false;
  if (onPage) return { verified: true, note: ocrConf != null ? `matched against OCR text (${ocrConf}% confidence)` : null };
  const elsewhere = texts.pages.findIndex((t) => norm(t).includes(q));
  if (elsewhere >= 0) return { verified: true, note: `found on page ${elsewhere + 1}, not page ${page ?? '?'}` };
  return { verified: false, note: page != null ? `quote not found on page ${page}` : 'quote not found in the document' };
}

/** The ledger, reconciled with the real page count: pages the model did not mention are unattested. */
export function buildLedger(ledger: PageLedger | null | undefined, texts: PageTexts, pageCountHint?: number | null): PageRow[] {
  const count = Math.max(texts.pages.length, pageCountHint ?? 0, ...(ledger ?? []).map((l) => l.page));
  const byPage = new Map((ledger ?? []).map((l) => [l.page, l.verdict] as const));
  const rows: PageRow[] = [];
  for (let p = 1; p <= count; p++) rows.push({ page: p, verdict: byPage.get(p) ?? 'unattested', textChars: (texts.pages[p - 1] ?? '').replace(/\s+/g, '').length, ocr: texts.ocr?.[p - 1] ?? null });
  return rows;
}

const snake = (k: string) => k.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
/** Which TA6 / TA7 section each answer sits in (PropertyFormsFacts.pages is kept per section). */
const FORM_SECTION: Record<string, 'boundaries' | 'disputes' | 'notices' | 'alterations' | 'guarantees' | 'insurance' | 'environment' | 'rights' | 'occupiers' | 'services' | 'leasehold'> = {
  disputes: 'disputes', notices: 'notices', alterations: 'alterations', alterationsConsented: 'alterations', alterationsDocumentsEnclosed: 'alterations', alterationsYear: 'alterations', listedOrConservation: 'alterations',
  windowsReplacedSince2002: 'alterations', windowsCertificate: 'alterations', solarPanelsLeased: 'alterations', solarPanelsOwned: 'alterations',
  guaranteesOutstandingClaims: 'guarantees', insuranceClaims: 'insurance', insuranceRefused: 'insurance',
  flooded: 'environment', floodDetail: 'environment', japaneseKnotweed: 'environment', knotweedDetail: 'environment', knotweedCategory: 'environment', radonTestAboveAction: 'environment', epcRating: 'environment',
  occupiers: 'occupiers', sharedAccessOrServices: 'rights', rightsOfWayOverProperty: 'rights', boundariesUnclear: 'boundaries',
  septicTank: 'services', electricalWorkSince2005: 'services', electricalCertificate: 'services', gasApplianceNoRecord: 'services', privateWater: 'services', leaseholdArrearsOrDispute: 'leasehold',
};
const flagRows = (prefix: string, flags: Flag[] | undefined): Array<Omit<FactRow, 'verified' | 'note'>> =>
  (flags ?? []).map((f) => ({ key: `${prefix}:${f.code}`, value: f.description, page: f.locator?.page ?? null, quote: f.locator?.quote ?? null, confidence: null }));

/** Typed facts → rows of the register. Keys are stable per document kind so cross-checks can be written against them. */
export function flattenFacts(role: string, facts: unknown, raw?: unknown): Array<Omit<FactRow, 'verified' | 'note'>> {
  const out: Array<Omit<FactRow, 'verified' | 'note'>> = [];
  const plain = (key: string, value: unknown) => { if (value !== undefined && value !== null && value !== '' && value !== 0) out.push({ key, value: String(value), page: null, quote: null, confidence: null }); };
  const r = (raw ?? {}) as Record<string, unknown>;
  const list = (key: string, v: unknown) => { if (Array.isArray(v)) v.forEach((x, i) => plain(`${key}.${i}`, typeof x === 'string' ? x.trim() : x)); };
  // Identity facts the typed shapes drop but the cross-checks need: who, where, which title.
  if (role.startsWith('search')) plain('search.address', r.propertyAddressAsSearched);
  if (role === 'mortgage') { plain('offer.address', r.propertyAddress); list('offer.borrower', r.borrowerNames); }
  if (role === 'title') { plain('title.property_description', r.propertyDescription); list('title.proprietor', r.registeredProprietors); }
  if (role === 'id_check') list('id.subject', r.subjectNames);
  if (role.startsWith('search')) {
    const f = facts as SearchFacts;
    plain('search.type', f.searchType);
    for (const [k, v] of Object.entries(f.summaryFields ?? {})) plain(`search.field.${k.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`, v);
    out.push(...flagRows('search.flag', f.flags));
  } else if (role === 'title') {
    const f = facts as TitleFacts;
    plain('title.number', f.titleNumber);
    plain('title.tenure', f.tenure);
    for (const e of f.restrictions) out.push({ key: `title.restriction.${e.code}`, value: e.text, page: e.locator?.page ?? null, quote: e.locator?.quote ?? e.text, confidence: null });
    for (const e of f.charges) out.push({ key: `title.charge.${e.code}`, value: e.text, page: e.locator?.page ?? null, quote: e.locator?.quote ?? e.text, confidence: null });
    for (const e of f.covenants) out.push({ key: `title.covenant.${e.code}`, value: e.text, page: e.locator?.page ?? null, quote: e.locator?.quote ?? e.text, confidence: null });
    if (f.lease) {
      plain('lease.unexpired_years', f.lease.unexpiredYears);
      plain('lease.ground_rent_pennies_pa', f.lease.groundRentPenniesPa);
      plain('lease.ground_rent_review', f.lease.groundRentReview);
      plain('lease.date', f.lease.leaseDate);
      plain('lease.landlord', f.lease.landlord);
    }
  } else if (role === 'mortgage') {
    const f = facts as MortgageOfferFacts;
    plain('offer.lender', f.lender);
    plain('offer.amount_pennies', f.amountPennies);
    plain('offer.expiry_date', f.expiryDate);
    for (const c of f.conditions) out.push({ key: `offer.condition.${c.code}${c.standard ? '' : '.special'}`, value: c.text, page: c.locator?.page ?? null, quote: c.locator?.quote ?? c.text, confidence: null });
  } else if (role === 'id_check') {
    const f = facts as IdCheckFacts;
    plain('id.provider', f.provider);
    plain('id.outcome', f.outcome);
    out.push(...flagRows('id.flag', f.flags));
  } else if (role === 'contract') {
    const f = facts as ContractFacts;
    list('contract.seller', f.sellers);
    list('contract.buyer', f.buyers);
    plain('contract.address', f.propertyAddress);
    plain('contract.title_number', f.titleNumber);
    plain('contract.price_pennies', f.pricePennies);
    plain('contract.deposit_pennies', f.depositPennies);
    plain('contract.deposit_holder', f.depositHolder);
    plain('contract.completion_date', f.completionDate);
    plain('contract.chattels_price_pennies', f.chattelsPricePennies);
    plain('contract.vat', f.vat);
    plain('contract.incorporated_conditions', f.incorporatedConditions);
    plain('contract.notice_to_complete_days', f.noticeToCompleteDays);
    plain('contract.fixtures_list', f.fixturesListPresent ? 'present' : 'absent');
    for (const c of f.specialConditions) out.push({ key: `contract.special_condition.${c.code}`, value: c.text, page: c.locator?.page ?? null, quote: c.locator?.quote ?? c.text, confidence: null });
    f.indemnities.forEach((c, i) => out.push({ key: `contract.indemnity.${i + 1}`, value: c.text, page: c.locator?.page ?? null, quote: c.locator?.quote ?? c.text, confidence: null }));
    out.push(...flagRows('contract.flag', f.flags));
  } else if (role === 'lease') {
    const f = facts as LeaseFacts;
    plain('lease.demise', f.demise);
    plain('lease.landlord', f.landlord);
    plain('lease.management_company', f.managementCompany);
    plain('lease.term_years', f.termYears);
    plain('lease.term_start_date', f.termStartDate);
    plain('lease.date', f.leaseDate);
    plain('lease.unexpired_years', f.unexpiredYears);
    plain('lease.ground_rent_pennies_pa', f.groundRentPenniesPa);
    plain('lease.ground_rent_review', f.groundRentReview);
    plain('lease.service_charge_proportion', f.serviceChargeProportion);
    plain('lease.repairs', f.repairs);
    plain('lease.alienation', f.alienation);
    plain('lease.alterations', f.alterations);
    plain('lease.permitted_use', f.permittedUse);
    plain('lease.insurance', f.insurance);
    plain('lease.landlord_notices', f.landlordNotices);
    plain('lease.forfeiture', f.forfeiture);
    for (const c of f.clauses ?? []) out.push({ key: `lease.clause.${c.topic}.${c.code}`, value: c.text, page: c.locator?.page ?? null, quote: c.locator?.quote ?? c.text, confidence: null });
    out.push(...flagRows('lease.flag', f.flags));
  } else if (role === 'management_pack') {
    const f = facts as ManagementPackFacts;
    plain('pack.landlord', f.landlord);
    plain('pack.managing_agent', f.managingAgent);
    plain('pack.service_charge_pennies_pa', f.serviceChargePenniesPa);
    plain('pack.service_charge_period', f.serviceChargePeriod);
    plain('pack.service_charge_proportion', f.serviceChargeProportion);
    plain('pack.ground_rent_pennies_pa', f.groundRentPenniesPa);
    plain('pack.arrears_pennies', f.arrearsPennies);
    plain('pack.reserve_fund_pennies', f.reserveFundPennies);
    plain('pack.major_works_planned', f.majorWorksPlanned == null ? null : f.majorWorksPlanned ? 'yes' : 'no');
    plain('pack.major_works', f.majorWorks);
    plain('pack.section_20_notice', f.section20Notice == null ? null : f.section20Notice ? 'yes' : 'no');
    plain('pack.buildings_insurance', f.buildingsInsuranceInPlace == null ? null : f.buildingsInsuranceInPlace ? 'in place' : 'not in place');
    plain('pack.insurer', f.insurer);
    plain('pack.insured_sum_pennies', f.insuredSumPennies);
    plain('pack.insurance_expiry_date', f.insuranceExpiryDate);
    plain('pack.fee.notice_of_assignment_pennies', f.fees?.noticeOfAssignmentPennies);
    plain('pack.fee.notice_of_charge_pennies', f.fees?.noticeOfChargePennies);
    plain('pack.fee.deed_of_covenant_pennies', f.fees?.deedOfCovenantPennies);
    plain('pack.fee.certificate_of_compliance_pennies', f.fees?.certificateOfCompliancePennies);
    plain('pack.fee.other', f.fees?.other);
    plain('pack.consents_required', f.consentsRequired);
    plain('pack.disputes', f.disputes);
    plain('pack.accounts_provided', f.accountsProvided);
    for (const e of f.entries ?? []) out.push({ key: `pack.entry.${e.code}`, value: e.text, page: e.locator?.page ?? null, quote: e.locator?.quote ?? e.text, confidence: null });
    out.push(...flagRows('pack.flag', f.flags));
  } else if (role.startsWith('enquiry')) {
    const f = facts as EnquiryReplyFacts;
    plain('reply.enquiry', f.enquiryId);
    plain('reply.status', f.status);
    out.push(...flagRows('reply.issue', f.issues));
  } else if (role === 'property_forms') {
    const f = facts as PropertyFormsFacts;
    list('forms.form', f.forms);
    // Each answer on the page of its section, so a TA6 answer is checked and cited like a contract term.
    const page = (k: string): number | null => (f.pages ?? {})[FORM_SECTION[k] ?? ('' as never)] ?? null;
    for (const [k, v] of Object.entries(f.answers ?? {})) {
      if (v === null || v === undefined || v === '') continue;
      const value = typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v).trim();
      if (value) out.push({ key: `forms.${snake(k)}`, value, page: page(k), quote: null, confidence: null });
    }
    (f.notKnown ?? []).forEach((n, i) => out.push({ key: `forms.not_known.${i + 1}`, value: n.question, page: n.page ?? null, quote: null, confidence: null }));
    out.push(...flagRows('forms.disclosure', f.disclosures));
  } else if (role === 'supporting_document') {
    const f = facts as SupportingDocFacts;
    plain('support.kind', f.kind);
    plain('support.title', f.title);
    plain('support.covers', f.covers);
    plain('support.issued_by', f.issuedBy);
    plain('support.reference', f.reference);
    plain('support.date', f.date);
    plain('support.expires', f.expires);
    plain('support.limit_pennies', f.limitPennies);
    plain('support.benefit_passes', f.benefitPasses == null ? null : f.benefitPasses ? 'yes' : 'no');
    plain('support.property', f.property);
    list('support.note', f.notes);
  } else if (role === 'title_plan') {
    const f = facts as TitlePlanFacts;
    plain('plan.title_number', f.titleNumber === 'UNKNOWN' ? null : f.titleNumber);
    plain('plan.edged_red', f.edgedRed);
    f.otherMarkings.forEach((m, i) => plain(`plan.marking.${i + 1}`, `${m.marking}: ${m.marks}`));
    plain('plan.reference', f.reference);
    list('plan.note', f.notes);
  } else if (role === 'survey') {
    const f = facts as SurveyFacts;
    plain('survey.type', f.surveyType);
    plain('survey.surveyor', f.surveyor);
    plain('survey.market_value_pennies', f.marketValuePennies);
    plain('survey.reinstatement_cost_pennies', f.reinstatementCostPennies);
    for (const rec of f.recommendations) out.push({ key: `survey.recommendation.${rec.code}`, value: rec.text, page: rec.locator?.page ?? null, quote: null, confidence: null });
    (f.legalIssues ?? []).forEach((l, i) => out.push({ key: `survey.legal.${l.category}.${i + 1}`, value: l.text, page: l.locator?.page ?? null, quote: null, confidence: null }));
    list('survey.risk', f.risks);
  } else if (role === 'statement') {
    // Who, which account and which period: enough to cite and cross-check; the transactions stay with proof of funds.
    const f = facts as { notStatement?: boolean; accountHolder?: string | null; bankName?: string | null; accountLast4?: string | null; periodFrom?: string | null; periodTo?: string | null; openingBalancePennies?: number | null; closingBalancePennies?: number | null; kind?: string };
    if (f.notStatement) plain('statement.document_kind', f.kind);
    else {
      plain('statement.account_holder', f.accountHolder);
      plain('statement.bank', f.bankName);
      plain('statement.account_last4', f.accountLast4);
      plain('statement.period_from', f.periodFrom);
      plain('statement.period_to', f.periodTo);
      plain('statement.opening_balance_pennies', f.openingBalancePennies);
      plain('statement.closing_balance_pennies', f.closingBalancePennies);
    }
  }
  return out;
}

export function buildReview(input: { role: string; facts: unknown; ledger: PageLedger | null | undefined; texts: PageTexts; pageCountHint?: number | null; raw?: unknown }): DocumentReview {
  const pages = buildLedger(input.ledger, input.texts, input.pageCountHint);
  // The extractor's confidence in its reading, on every fact it took from it (a field without its own).
  const docConfidence = typeof (input.facts as { confidence?: unknown } | null)?.confidence === 'number' ? (input.facts as { confidence: number }).confidence : null;
  const facts: FactRow[] = flattenFacts(input.role, input.facts, input.raw).map((row) => ({ ...row, confidence: row.confidence ?? docConfidence })).map((f) => {
    if (!f.quote) return { ...f, verified: false, note: f.page == null ? 'stated without a quote' : 'no quote' };
    const v = verifyQuote(f.quote, f.page, input.texts);
    return { ...f, verified: v.verified, note: v.note };
  });
  const read = pages.filter((p) => p.verdict !== 'unattested').length;
  const withFacts = pages.filter((p) => p.verdict === 'facts').length;
  const unreadable = pages.filter((p) => p.verdict === 'unreadable').length;
  const unattested = pages.length - read;
  return {
    role: input.role,
    pages,
    facts,
    summary: { pages: pages.length, read, withFacts, unreadable, unattested, complete: pages.length > 0 && unattested === 0, facts: facts.length, verified: facts.filter((f) => f.verified).length, textLayer: input.texts.textLayer },
  };
}

/** One line for a person: "18 of 18 pages read · 3 with facts · 2 unreadable". */
export function coverageLine(s: DocumentReview['summary']): string {
  const bits = [`${s.read} of ${s.pages} page${s.pages === 1 ? '' : 's'} read`];
  if (s.withFacts) bits.push(`${s.withFacts} with facts`);
  if (s.unreadable) bits.push(`${s.unreadable} unreadable`);
  if (s.unattested) bits.push(`${s.unattested} not attested`);
  if (!s.textLayer) bits.push('no text layer');
  return bits.join(' · ');
}

export interface RegisterDiff { added: Array<{ key: string; value: string }>; removed: Array<{ key: string; value: string }>; changed: Array<{ key: string; from: string; to: string }> }
/** What a re-read changed: facts by key, before and after. Empty lists mean the two reads agree. */
export function diffRegister(prev: Array<{ key: string; value: string }>, next: Array<{ key: string; value: string }>): RegisterDiff {
  const a = new Map(prev.map((f) => [f.key, f.value]));
  const b = new Map(next.map((f) => [f.key, f.value]));
  const same = (x: string, y: string) => x.trim().toLowerCase() === y.trim().toLowerCase();
  const out: RegisterDiff = { added: [], removed: [], changed: [] };
  for (const [key, value] of b) { const was = a.get(key); if (was == null) out.added.push({ key, value }); else if (!same(was, value)) out.changed.push({ key, from: was, to: value }); }
  for (const [key, value] of a) if (!b.has(key)) out.removed.push({ key, value });
  return out;
}
export const diffLine = (d: RegisterDiff): string => { const bits = []; if (d.changed.length) bits.push(`${d.changed.length} changed`); if (d.added.length) bits.push(`${d.added.length} added`); if (d.removed.length) bits.push(`${d.removed.length} gone`); return bits.length ? `Since the last read: ${bits.join(', ')}.` : 'Same facts as the last read.'; };
