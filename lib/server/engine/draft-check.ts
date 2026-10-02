/**
 * Drafter on the register (Document Review Engine, part 6): a draft may only state what
 * the file shows. Every figure, date, title number, postcode, percentage and named person
 * in a draft is looked up in the fact register (and the case record); a claim that matches
 * nothing is struck and listed under "not from the file", and every sentence carries the
 * ids of the facts it rests on so the reader can open the page at the quote.
 *
 * Pure: `checkDraft` takes the text and the register and returns the check; `renderChecked`
 * turns it into the plain-text form that is filed as the draft document.
 */
import { normName, parsePennies } from './crosscheck';

export interface RegisterFact { id: string; documentId: string; documentLabel: string; key: string; value: string; page: number | null; quote: string | null }
export type ClaimKind = 'money' | 'date' | 'title_number' | 'postcode' | 'percent' | 'name';
export interface Claim { kind: ClaimKind; text: string; start: number; end: number; factIds: string[]; allowed: boolean }
export interface CheckedSentence { text: string; start: number; end: number; /** paragraph index: a line break in the draft starts a new one */ para: number; factIds: string[]; struck: Array<{ text: string; kind: ClaimKind; start: number; end: number }> }
export interface DraftCheck {
  sentences: CheckedSentence[];
  notFromFile: Array<{ text: string; kind: ClaimKind; sentence: string }>;
  /** Facts cited anywhere in the draft, in order of first use; the citation number is the index + 1. */
  cited: RegisterFact[];
  summary: { sentences: number; claims: number; matched: number; struck: number; cited: number };
}

const KIND_LABEL: Record<ClaimKind, string> = { money: 'amount', date: 'date', title_number: 'title number', postcode: 'postcode', percent: 'percentage', name: 'name' };
export const claimKindLabel = (k: ClaimKind) => KIND_LABEL[k];

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const MONTH_RE = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const RE = {
  money: /£\s?\d[\d,]*(?:\.\d{1,2})?\b|\b\d[\d,]*(?:\.\d{1,2})?\s?(?:pounds|GBP)\b/gi,
  date: new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\.?,?\\s+\\d{4}\\b|\\b${MONTH_RE}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}\\b|\\b\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{4}\\b|\\b\\d{4}-\\d{2}-\\d{2}\\b`, 'gi'),
  title_number: /\b[A-Z]{1,3}\d{4,7}\b/g,
  postcode: /\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/g,
  percent: /\b\d+(?:\.\d+)?\s?%/g,
  name: /\b(?:Mr|Mrs|Ms|Miss|Mx|Dr|Prof|Professor|Sir|Dame|Lord|Lady|Rev)\.?\s+((?:[A-Z][a-z'’-]+|[A-Z]\.?)(?:\s+(?:[A-Z][a-z'’-]+|[A-Z]\.?)){0,3})/g,
};

/** Canonical forms: what two writings of the same fact reduce to. */
export const canon = {
  money: (s: string): string | null => {
    const p = parsePennies(s.replace(/\s?(pounds|GBP)/i, '').replace(/^£\s?/, ''));
    return p == null ? null : String(p);
  },
  date: (s: string): string | null => {
    const t = s.trim().replace(/(\d)(?:st|nd|rd|th)\b/g, '$1').replace(/\bof\b/i, '').replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
    let m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = t.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
    if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; // UK: day first
    m = t.match(/^(\d{1,2}) ([a-z]+) (\d{4})$/i);
    if (m && MONTHS[m[2].toLowerCase().slice(0, 3)]) return `${m[3]}-${String(MONTHS[m[2].toLowerCase().slice(0, 3)]).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    m = t.match(/^([a-z]+) (\d{1,2}) (\d{4})$/i);
    if (m && MONTHS[m[1].toLowerCase().slice(0, 3)]) return `${m[3]}-${String(MONTHS[m[1].toLowerCase().slice(0, 3)]).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  },
  title_number: (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, ''),
  postcode: (s: string) => s.toUpperCase().replace(/\s+/g, ''),
  percent: (s: string) => String(Number(s.replace(/[%\s]/g, ''))),
  name: (s: string) => normName(s).surname,
};

/** Every canonical claim a value can stand for: a price fact stands for its amount, an address fact for its postcode, a name fact for its surname. */
export function canonsOf(key: string, value: string): Array<{ kind: ClaimKind; canon: string }> {
  const out: Array<{ kind: ClaimKind; canon: string }> = [];
  const v = value.trim();
  if (/_pennies(?:_|$)/.test(key) && /^\d+$/.test(v)) out.push({ kind: 'money', canon: v });
  for (const m of v.matchAll(RE.money)) { const c = canon.money(m[0]); if (c) out.push({ kind: 'money', canon: c }); }
  if (/^\d[\d,]*(?:\.\d{1,2})?$/.test(v) && !/_pennies(?:_|$)/.test(key) && /(price|amount|deposit|fee|rent|premium|advance|loan|sum|balance|total|charge)/i.test(key)) { const c = canon.money(v); if (c) out.push({ kind: 'money', canon: c }); }
  for (const m of v.matchAll(RE.date)) { const c = canon.date(m[0]); if (c) out.push({ kind: 'date', canon: c }); }
  if (/(date|expiry|expires|_at|_on)$/i.test(key) && !out.some((o) => o.kind === 'date')) { const c = canon.date(v); if (c) out.push({ kind: 'date', canon: c }); }
  for (const m of v.matchAll(RE.title_number)) out.push({ kind: 'title_number', canon: canon.title_number(m[0]) });
  if (/title_number$|^title\.number$/.test(key)) out.push({ kind: 'title_number', canon: canon.title_number(v) });
  for (const m of v.matchAll(RE.postcode)) out.push({ kind: 'postcode', canon: canon.postcode(m[0]) });
  for (const m of v.matchAll(RE.percent)) out.push({ kind: 'percent', canon: canon.percent(m[0]) });
  if (/(rate|percent|apr|ltv)/i.test(key) && /^\d+(?:\.\d+)?$/.test(v)) out.push({ kind: 'percent', canon: canon.percent(v) });
  if (/(buyer|seller|borrower|proprietor|subject|name|client|applicant|lessee|lessor|landlord|tenant|party|purchaser|vendor|transferor|transferee)/i.test(key) && /[a-z]/i.test(v) && !/\d/.test(v)) { const s = canon.name(v); if (s) out.push({ kind: 'name', canon: s }); }
  return out;
}

/** Split into sentences; a heading or a list line is its own sentence. */
export function splitSentences(text: string): Array<{ text: string; start: number; end: number }> {
  const out: Array<{ text: string; start: number; end: number }> = [];
  const re = /[^\n]+?(?:[.!?](?=\s+[A-Z£"'(\d\[])|(?=\n)|$)/g;
  for (const m of text.matchAll(re)) {
    const t = m[0];
    const lead = t.length - t.trimStart().length;
    const body = t.trim();
    if (!body) continue;
    out.push({ text: body, start: (m.index ?? 0) + lead, end: (m.index ?? 0) + lead + body.length });
  }
  return out;
}

function findClaims(text: string): Array<Omit<Claim, 'factIds' | 'allowed'>> {
  const found: Array<Omit<Claim, 'factIds' | 'allowed'>> = [];
  const add = (kind: ClaimKind, m: RegExpMatchArray, text: string) => {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (found.some((f) => start < f.end && end > f.start)) return; // an earlier, more specific kind owns this span
    found.push({ kind, text, start, end });
  };
  for (const m of text.matchAll(RE.date)) add('date', m, m[0]);
  for (const m of text.matchAll(RE.money)) add('money', m, m[0]);
  for (const m of text.matchAll(RE.percent)) add('percent', m, m[0]);
  for (const m of text.matchAll(RE.postcode)) add('postcode', m, m[0]);
  for (const m of text.matchAll(RE.title_number)) add('title_number', m, m[0]);
  for (const m of text.matchAll(RE.name)) add('name', m, m[1]);
  return found.sort((a, b) => a.start - b.start);
}

/**
 * Check a draft against the register. `allowed` is what the case record itself says (the
 * price, the address, the parties, the target dates): a claim that matches only the record is
 * not struck but carries no citation.
 */
export function checkDraft(text: string, facts: RegisterFact[], opts: { allowed?: string[] } = {}): DraftCheck {
  const byCanon = new Map<string, string[]>(); // `${kind}:${canon}` → fact ids
  const allowed = new Set<string>();
  for (const f of facts) for (const c of canonsOf(f.key, f.value)) { const k = `${c.kind}:${c.canon}`; (byCanon.get(k) ?? byCanon.set(k, []).get(k)!).push(f.id); }
  for (const a of opts.allowed ?? []) if (a) for (const c of canonsOf('record.value', a)) allowed.add(`${c.kind}:${c.canon}`);
  // The record's names and amounts arrive under generic keys; widen them so a bare figure or a name in the record still counts.
  for (const a of opts.allowed ?? []) {
    if (!a) continue;
    const s = canon.name(a); if (s && /^[a-z' -]+$/i.test(a)) allowed.add(`name:${s}`);
    const m = canon.money(a); if (m && /^\d[\d,]*(?:\.\d{1,2})?$/.test(a.trim())) allowed.add(`money:${m}`);
    const d = canon.date(a); if (d && /\d{4}/.test(a)) allowed.add(`date:${d}`);
  }
  const factById = new Map(facts.map((f) => [f.id, f]));
  const cited: RegisterFact[] = [];
  const cite = (id: string) => { if (!cited.some((c) => c.id === id)) { const f = factById.get(id); if (f) cited.push(f); } };
  const claims: Claim[] = findClaims(text).map((c) => {
    const k = canon[c.kind](c.text);
    const ids = k == null ? [] : byCanon.get(`${c.kind}:${k}`) ?? [];
    return { ...c, factIds: ids, allowed: k != null && allowed.has(`${c.kind}:${k}`) };
  });
  let para = 0;
  let last = 0;
  const sentences: CheckedSentence[] = splitSentences(text).map((s) => {
    if (text.slice(last, s.start).includes('\n')) para++;
    last = s.end;
    const inside = claims.filter((c) => c.start >= s.start && c.end <= s.end);
    const factIds: string[] = [];
    for (const c of inside) for (const id of c.factIds) if (!factIds.includes(id)) { factIds.push(id); cite(id); }
    const struck = inside.filter((c) => !c.factIds.length && !c.allowed).map((c) => ({ text: c.text, kind: c.kind, start: c.start - s.start, end: c.end - s.start }));
    return { text: s.text, start: s.start, end: s.end, para, factIds, struck };
  });
  const notFromFile = sentences.flatMap((s) => s.struck.map((c) => ({ text: c.text, kind: c.kind, sentence: s.text })));
  const matched = claims.filter((c) => c.factIds.length || c.allowed).length;
  return { sentences, notFromFile, cited, summary: { sentences: sentences.length, claims: claims.length, matched, struck: claims.length - matched, cited: cited.length } };
}

/** The filed form of a checked draft: each sentence numbered to its sources, struck claims marked, and the two lists a reviewer needs at the end. */
export function renderChecked(text: string, check: DraftCheck): string {
  const num = new Map(check.cited.map((f, i) => [f.id, i + 1]));
  let out = '';
  let cur = 0;
  for (const s of check.sentences) {
    out += text.slice(cur, s.start);
    let body = '';
    let c = 0;
    for (const k of s.struck) { body += s.text.slice(c, k.start) + `[NOT ON FILE: ${s.text.slice(k.start, k.end)}]`; c = k.end; }
    body += s.text.slice(c);
    const refs = s.factIds.map((id) => num.get(id)).filter((n): n is number => !!n);
    out += body + (refs.length ? ` [${refs.join(', ')}]` : '');
    cur = s.end;
  }
  out += text.slice(cur);
  const lines = [out.trimEnd(), ''];
  if (check.notFromFile.length) {
    lines.push('NOT FROM THE FILE', ...check.notFromFile.map((n) => `- ${n.text} (${KIND_LABEL[n.kind]}) — no document on the file states this`), '');
  }
  if (check.cited.length) {
    lines.push('SOURCES', ...check.cited.map((f, i) => `${i + 1}. ${f.documentLabel}${f.page ? ` p.${f.page}` : ''} — ${f.key}: ${f.value}${f.quote ? ` — “${f.quote.slice(0, 160)}${f.quote.length > 160 ? '…' : ''}”` : ''}`), '');
  }
  return lines.join('\n');
}

/** For a template fill: mark what is not on the file inline and return the text; nothing else changes. */
export function markUnsupported(text: string, check: DraftCheck): string {
  let out = '';
  let cur = 0;
  for (const s of check.sentences) {
    out += text.slice(cur, s.start);
    let body = '';
    let c = 0;
    for (const k of s.struck) { body += s.text.slice(c, k.start) + `[NOT ON FILE: ${s.text.slice(k.start, k.end)}]`; c = k.end; }
    out += body + s.text.slice(c);
    cur = s.end;
  }
  return out + text.slice(cur);
}

/** One line for a summary: what the check found. */
export function draftCheckLine(c: DraftCheck): string {
  if (!c.summary.claims) return 'No figures, dates or names to check.';
  return `${c.summary.matched} of ${c.summary.claims} figures, dates and names match the file; ${c.summary.struck} not from the file; ${c.summary.cited} source facts cited.`;
}

/**
 * Every point found on the title, the searches and the lease must reach the client (property.md 9.4): a point counts as
 * covered when the report uses its distinctive words. What is left is listed for the person approving the report.
 */
export function pointsNotInReport(text: string, points: string[]): string[] {
  const body = text.toLowerCase();
  const STOP = new Set(['there', 'their', 'which', 'about', 'title', 'search', 'property', 'notice', 'register', 'should', 'would', 'before', 'after', 'under', 'with', 'from', 'that', 'this', 'have']);
  return points.filter((p) => {
    const words = [...new Set(p.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 4 && !STOP.has(w)))];
    if (!words.length) return false;
    const hits = words.filter((w) => body.includes(w.slice(0, Math.max(5, w.length - 2)))).length;
    return hits < Math.min(2, words.length);
  });
}
