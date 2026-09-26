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
import type { ContractFacts, EnquiryReplyFacts, Flag, IdCheckFacts, MortgageOfferFacts, SearchFacts, TitleFacts } from './types';

export type PageVerdict = 'facts' | 'nothing' | 'unreadable' | 'unattested';

export interface PageRow { page: number; verdict: PageVerdict; textChars: number }
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

export interface PageTexts { pages: string[]; textLayer: boolean }

/** Per-page text of a PDF through pdf.js; an image or a scan without a text layer yields empty pages. */
export async function pdfPageTexts(bytes: Buffer): Promise<PageTexts> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    pages.push(content.items.map((it) => ('str' in it ? it.str : '')).join(' '));
  }
  await (doc as unknown as { cleanup?: () => Promise<void> }).cleanup?.().catch(() => {});
  return { pages, textLayer: pages.some((p) => p.replace(/\s+/g, '').length > 20) };
}

const norm = (s: string) => s.toLowerCase().replace(/[‘’“”]/g, "'").replace(/[^a-z0-9£$%.,;:/()'-]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Is the quote in the page's text? Whitespace, case and quote marks are forgiven; words are not. */
export function verifyQuote(quote: string | null | undefined, page: number | null, texts: PageTexts): { verified: boolean; note: string | null } {
  if (!quote || !quote.trim()) return { verified: false, note: 'no quote' };
  if (!texts.textLayer) return { verified: false, note: 'no text layer to check against' };
  const q = norm(quote);
  if (q.length < 6) return { verified: false, note: 'quote too short to check' };
  const onPage = page != null && texts.pages[page - 1] ? norm(texts.pages[page - 1]).includes(q) : false;
  if (onPage) return { verified: true, note: null };
  const elsewhere = texts.pages.findIndex((t) => norm(t).includes(q));
  if (elsewhere >= 0) return { verified: true, note: `found on page ${elsewhere + 1}, not page ${page ?? '?'}` };
  return { verified: false, note: page != null ? `quote not found on page ${page}` : 'quote not found in the document' };
}

/** The ledger, reconciled with the real page count: pages the model did not mention are unattested. */
export function buildLedger(ledger: PageLedger | null | undefined, texts: PageTexts, pageCountHint?: number | null): PageRow[] {
  const count = Math.max(texts.pages.length, pageCountHint ?? 0, ...(ledger ?? []).map((l) => l.page));
  const byPage = new Map((ledger ?? []).map((l) => [l.page, l.verdict] as const));
  const rows: PageRow[] = [];
  for (let p = 1; p <= count; p++) rows.push({ page: p, verdict: byPage.get(p) ?? 'unattested', textChars: (texts.pages[p - 1] ?? '').replace(/\s+/g, '').length });
  return rows;
}

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
  } else if (role.startsWith('enquiry')) {
    const f = facts as EnquiryReplyFacts;
    plain('reply.enquiry', f.enquiryId);
    plain('reply.status', f.status);
    out.push(...flagRows('reply.issue', f.issues));
  }
  return out;
}

export function buildReview(input: { role: string; facts: unknown; ledger: PageLedger | null | undefined; texts: PageTexts; pageCountHint?: number | null; raw?: unknown }): DocumentReview {
  const pages = buildLedger(input.ledger, input.texts, input.pageCountHint);
  const facts: FactRow[] = flattenFacts(input.role, input.facts, input.raw).map((f) => {
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
