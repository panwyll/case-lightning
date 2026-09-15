/**
 * Component #5 — the hard guardrail around client Q&A.
 *
 * Rule from the spec: the automated channel answers PROCESS / FAQ questions only
 * ("what does exchange mean", "what happens next"). Anything that could be read as
 * advice on the client's specific transaction — money, dates, clauses, risks, "should
 * I" — is hard-blocked and routed to a person. The guard is DETERMINISTIC (regexes and
 * a static FAQ), tested against adversarial phrasings, and runs BEFORE any model.
 * The model's only permitted job is to rephrase a matched FAQ answer; its output is
 * checked again on the way out (see client-comms.ts).
 */

export type GuardVerdict = { verdict: 'ALLOW'; faqId: string; score: number } | { verdict: 'BLOCK'; reasons: string[] } | { verdict: 'NO_MATCH'; reasons: string[] };

/** Anything transaction-specific. Order matters only for the reason list. */
const BLOCK_PATTERNS: Array<[RegExp, string]> = [
  [/£\s?\d|\b\d+\s?(k|grand|pounds?)\b|\bstamp duty (bill|amount|cost)\b|\bhow much\b/i, 'money / figures'],
  [/\b(price|deposit|offer|valuation|survey|mortgage (rate|amount|offer)|redemption|fees?|costs?|refund|discount|retention)\b/i, 'transaction money terms'],
  [/\b(should i|should we|do you (think|recommend|advise)|would you|is it (safe|wise|ok|okay|worth)|can i (pull out|withdraw|negotiate)|what would you)\b/i, 'asks for advice'],
  [/\b(clause|condition \d|special condition|covenant|restriction|easement|indemnity|title (defect|number|plan|problem|issue|split|deed)|lease|freeholder|boundary|right of way|flood|subsidence|japanese knotweed|damp|planning|enforcement|listed|conservation)\b/i, 'specific legal / property issue'],
  [/\b(risk|risky|problem|issue|worried|concern|dispute|complain|sue|liab)/i, 'risk / concern about this transaction'],
  [/\b(my|our) (search|searches|contract|survey|enquir|solicitor|lender|seller|buyer|chain|completion date|exchange date|offer|property|house|flat)\b/i, 'refers to their own transaction'],
  [/\b(the seller|vendor|other side|estate agent|the agent|the lender|the bank)\b.*\b(said|says|told|wants|asking|refus|agreed)\b/i, 'reports a party position'],
  [/\b\d{1,2}(st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|\b(next|this) (week|friday|monday|month)\b|\bby when\b|\bdeadline\b/i, 'specific dates / timing commitments'],
  [/\b(gift|source of funds|inheritance|crypto|cash buyer|help to buy|shared ownership|company purchase|overseas|non.?resident)\b/i, 'circumstance-specific'],
];

export function guardClientQuestion(text: string): { blocked: boolean; reasons: string[] } {
  const reasons = BLOCK_PATTERNS.filter(([re]) => re.test(text)).map(([, r]) => r);
  return { blocked: reasons.length > 0, reasons };
}

// ───────────────────────────── FAQ (process only) ─────────────────────────────

export interface FaqEntry {
  id: string;
  question: string;
  keywords: string[];
  answer: string;
}

export const FAQ: FaqEntry[] = [
  { id: 'what_is_exchange', question: 'What does exchange of contracts mean?', keywords: ['exchange', 'exchanging', 'exchanged', 'contracts', 'binding'], answer: 'Exchange of contracts is the point at which the sale becomes legally binding on both sides. Before exchange either party can walk away; after it, both are committed to complete on the agreed completion date. The buyer usually pays the deposit at exchange.' },
  { id: 'what_is_completion', question: 'What does completion mean?', keywords: ['completion', 'complete', 'completing', 'keys', 'move in', 'moving day'], answer: 'Completion is the day the purchase finishes: the money is transferred, ownership passes and the keys are released, usually through the estate agent once the seller\'s solicitor confirms funds have arrived. It normally happens on a weekday, often in the late morning or early afternoon.' },
  { id: 'what_are_searches', question: 'What are property searches?', keywords: ['search', 'searches', 'local authority', 'drainage', 'environmental', 'llc1', 'con29'], answer: 'Searches are enquiries made to public bodies about the property: the local authority (planning history, road adoption, local land charges), the water company (drainage and water connections) and an environmental data provider (flooding, contamination, ground stability). They tell us about matters that would not be obvious from looking at the property or the title.' },
  { id: 'how_long_searches', question: 'How long do searches take?', keywords: ['long', 'take', 'time', 'searches', 'wait', 'waiting', 'slow', 'weeks'], answer: 'It varies by local authority. Most come back within two to three weeks, some faster and a few slower. We chase automatically if a search is late and let you know when each one arrives.' },
  { id: 'what_are_enquiries', question: 'What are pre-contract enquiries?', keywords: ['enquiries', 'enquiry', 'questions', 'seller', 'replies'], answer: 'Pre-contract enquiries are written questions we put to the seller\'s solicitor about the property — for example about boundaries, alterations, guarantees and disputes. The seller answers them and we review the replies before you commit to buy.' },
  { id: 'what_is_report_on_title', question: 'What is a report on title?', keywords: ['report', 'title', 'report on title'], answer: 'The report on title is the summary we send you before exchange explaining what we found: the title to the property, the search results, the enquiry replies and, if you have one, the mortgage offer conditions. Reading it is your chance to ask questions before the purchase becomes binding.' },
  { id: 'what_happens_next', question: 'What happens next?', keywords: ['next', 'now', 'stage', 'progress', 'update', 'where are we', 'status', 'happening'], answer: 'A purchase moves through these stages: instructions and identity checks; the seller\'s contract pack; searches and enquiries; reviewing everything and reporting to you; signing and paying the deposit; exchange; completion; and finally the stamp duty return and Land Registry registration. We send an automatic update as each milestone is reached.' },
  { id: 'what_is_sdlt', question: 'What is stamp duty (SDLT)?', keywords: ['stamp duty', 'sdlt', 'tax', 'hmrc'], answer: 'Stamp Duty Land Tax is a tax paid to HMRC on most property purchases in England and Northern Ireland. A return has to be filed and any tax paid within 14 days of completion; we prepare and submit the return as part of the purchase. The amount depends on the price and your circumstances, which your conveyancer will confirm with you.' },
  { id: 'what_is_registration', question: 'What happens at the Land Registry?', keywords: ['land registry', 'registration', 'register', 'registered', 'deeds', 'ap1', 'ownership'], answer: 'After completion we apply to HM Land Registry to register you as the new owner and, if applicable, your lender\'s mortgage. Legal ownership formally passes on registration. The Land Registry can take some time to process applications; your position is protected in the meantime by a priority search we make before completion.' },
  { id: 'id_checks', question: 'Why do you need my ID?', keywords: ['id', 'identity', 'passport', 'driving licence', 'aml', 'money laundering', 'proof of address'], answer: 'Solicitors are legally required to verify the identity of every client and the source of the money used to buy, under anti-money-laundering rules. We use an electronic check where possible and may ask for documents to support it. The purchase cannot progress until these checks are complete.' },
  { id: 'what_is_deposit', question: 'When is the deposit paid?', keywords: ['deposit', 'when', 'pay', 'paid', '10%'], answer: 'The deposit is paid to us shortly before exchange of contracts so that it can be sent to the seller\'s solicitor on exchange. It is usually 10% of the price, though this is agreed between the parties. We will tell you the exact amount and when we need it.' },
  { id: 'what_is_chain', question: 'What is a chain?', keywords: ['chain', 'linked', 'dependent', 'related sale'], answer: 'A chain is a series of linked transactions where each purchase depends on a related sale completing on the same day. Exchange and completion have to be synchronised across the whole chain, which is why dates sometimes move.' },
];

const STOP = new Set(['the', 'a', 'an', 'is', 'are', 'what', 'does', 'do', 'mean', 'means', 'to', 'of', 'in', 'on', 'it', 'i', 'my', 'we', 'you', 'and', 'or', 'for', 'be', 'will', 'can', 'how', 'when', 'why', 'this', 'that', 'please', 'hi', 'hello', 'thanks']);

const tokens = (s: string): string[] => s.toLowerCase().replace(/[^a-z0-9% ]+/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w));

/**
 * Keyword overlap scoring. One matching keyword is enough to answer (the hard guard has
 * already removed anything transaction-specific, so a false match costs only a slightly
 * off-topic process answer); two or more is a confident match. Ties go to the entry with
 * the most hits, then FAQ order.
 */
export const FAQ_MIN_SCORE = 0.5;

export function matchFaq(text: string): { entry: FaqEntry; score: number } | null {
  const toks = tokens(text);
  if (!toks.length) return null;
  const lower = text.toLowerCase();
  let best: { entry: FaqEntry; score: number } | null = null;
  for (const entry of FAQ) {
    let hits = 0;
    // A multi-word phrase ('land registry', 'report on title') is a much stronger signal than a single token.
    for (const k of entry.keywords) if (k.includes(' ') ? lower.includes(k) : toks.includes(k)) hits += k.includes(' ') ? 2 : 1;
    const score = Math.min(1, hits / 2);
    if (!best || score > best.score) best = { entry, score };
  }
  return best && best.score >= FAQ_MIN_SCORE ? best : null;
}

/** Full verdict: block first, then FAQ. */
export function classifyClientQuestion(text: string): GuardVerdict {
  const g = guardClientQuestion(text);
  if (g.blocked) return { verdict: 'BLOCK', reasons: g.reasons };
  const m = matchFaq(text);
  if (!m) return { verdict: 'NO_MATCH', reasons: ['no FAQ match'] };
  return { verdict: 'ALLOW', faqId: m.entry.id, score: m.score };
}

/** Outbound check on a model rephrasing: no figures, no advice, no new facts beyond the FAQ answer. */
export function validateFaqReply(faq: FaqEntry, reply: string): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (/£\s?\d|\b\d{3,}\b/.test(reply) && !/£\s?\d|\b\d{3,}\b/.test(faq.answer)) problems.push('introduces a figure');
  if (/\b(you should|we recommend|i recommend|i advise|in your case|for your purchase|your (property|house|flat|seller|lender))\b/i.test(reply)) problems.push('gives transaction-specific advice');
  if (reply.trim().length < 40) problems.push('too short');
  if (reply.length > faq.answer.length * 2 + 200) problems.push('too long — likely padded with new content');
  return { ok: problems.length === 0, problems };
}
