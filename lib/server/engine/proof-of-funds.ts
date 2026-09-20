/**
 * Proof of funds (source of funds / source of wealth) — the automated flow, to the
 * standard the regulations and the Legal Sector Affinity Group guidance actually require
 * (docs/proof-of-funds.md §1): not "a statement is on file" but "the statements were READ,
 * every unusual transaction was QUERIED, the answers were recorded, and a person signed off".
 *
 *   conveyancer fires the form  →  client completes it (public, tokenised link), attaching
 *   statements  →  the statements are EXTRACTED transaction by transaction  →  DETERMINISTIC
 *   rules produce the flags — on the declaration (shortfall, gift, unevidenced source…) AND
 *   on individual transactions (large / cash / third-party / round-sum / crypto / gambling /
 *   overseas / in-and-out credits, balance and coverage checks)  →  each transaction flag
 *   drafts a QUERY to the client  →  the briefing (validated, template fallback)  →  ALWAYS
 *   a decision: approve / query (re-opens the form with the queries) / escalate / reject.
 *   The client's answers come back through the same form and are recorded on the log
 *   against the query; unanswered queries stay flagged.
 *
 * Nothing here decides anything. The rules say what a person must look at; the summary
 * explains it; the conveyancer signs off — AML sign-off is a human act. The thresholds are
 * the firm's policy (POF_POLICY) and are meant to be tuned by the MLRO.
 */
import type { Flag } from './types';
import type { Verdict } from './rules';

export const FUND_SOURCE_KINDS = [
  'savings',
  'sale_proceeds',
  'mortgage',
  'gift',
  'inheritance',
  'investment_sale',
  'pension',
  'remortgage_equity',
  'help_to_buy_isa',
  'lifetime_isa',
  'loan',
  'business_income',
  'crypto',
  'overseas',
  'other',
] as const;
export type FundSourceKind = (typeof FUND_SOURCE_KINDS)[number];

export const FUND_SOURCE_LABEL: Record<FundSourceKind, string> = {
  savings: 'Savings',
  sale_proceeds: 'Proceeds of a property sale',
  mortgage: 'Mortgage advance',
  gift: 'Gift',
  inheritance: 'Inheritance',
  investment_sale: 'Sale of investments / shares',
  pension: 'Pension lump sum',
  remortgage_equity: 'Equity release / remortgage',
  help_to_buy_isa: 'Help to Buy ISA',
  lifetime_isa: 'Lifetime ISA',
  loan: 'Loan (family, employer, other)',
  business_income: 'Business income / dividends',
  crypto: 'Cryptoassets',
  overseas: 'Funds from overseas',
  other: 'Other',
};

/** What the client is asked to attach for each source (shown on the form; the rules check counts, not contents). */
export const EVIDENCE_EXPECTED: Record<FundSourceKind, string> = {
  savings: 'Bank statements for the last 3 months showing the balance building up (all accounts the money sits in).',
  sale_proceeds: 'Completion statement or memorandum of sale for the property being sold; solicitor\'s details.',
  mortgage: 'Mortgage offer or decision in principle.',
  gift: 'A signed gift letter from the donor confirming the gift is not repayable and they claim no interest in the property; the donor\'s photo ID and 3 months of their statements showing the money.',
  inheritance: 'Grant of probate / letter from the estate\'s solicitor or executor, and the statement showing receipt.',
  investment_sale: 'Statement from the platform or broker showing the sale and the transfer to your account.',
  pension: 'Pension provider\'s letter or statement showing the lump sum and its receipt.',
  remortgage_equity: 'The new lender\'s offer and the redemption / completion statement.',
  help_to_buy_isa: 'ISA statement (the bonus is claimed by your conveyancer).',
  lifetime_isa: 'LISA statement (the bonus is claimed by your conveyancer).',
  loan: 'Loan agreement and evidence of the lender\'s funds; your mortgage lender must be told.',
  business_income: 'Business bank statements and the latest accounts / dividend vouchers.',
  crypto: 'Exchange statements showing purchases, the sale to sterling and the transfer to your bank.',
  overseas: 'Statements from the overseas account, evidence of the transfer, and how the money was earned.',
  other: 'Whatever shows where the money came from and that it is now yours.',
};

/** Sources the AML regime treats as higher risk (enhanced due diligence questions follow). */
export const HIGH_RISK_SOURCES: ReadonlySet<FundSourceKind> = new Set(['crypto', 'overseas', 'loan', 'business_income']);

/** One row of the client's declaration. */
export interface FundSource {
  kind: FundSourceKind;
  amountPennies: number;
  /** Where it sits / how it arose, in the client's words. */
  description: string;
  accountHolder?: string | null;
  bankName?: string | null;
  /** Documents the client attached for this source (ids of rows in `document`). */
  evidenceDocumentIds: string[];
  gift?: {
    donorName: string;
    donorRelationship: string;
    donorAddress?: string | null;
    /** A "gift" that must be repaid is a loan and the lender must know. */
    repayable: boolean;
    donorAbroad: boolean;
    donorEvidenceDocumentIds: string[];
  } | null;
  overseas?: { country: string; alreadyInUk: boolean } | null;
}

/** The whole form as the client submitted it (stored verbatim on proof_of_funds_request.submission). */
export interface ProofOfFundsSubmission {
  declarant: { fullName: string; email?: string | null; phone?: string | null };
  purchasePricePennies: number | null;
  mortgageAdvancePennies: number | null;
  sources: FundSource[];
  declarations: {
    /** "The information is complete and accurate." */
    accurate: boolean;
    /** "No one else has an interest in the money or the property." */
    noThirdPartyInterest: boolean;
    /** "None of the money is borrowed except as stated." */
    noUndisclosedBorrowing: boolean;
  };
  clientNote?: string | null;
  submittedAt: string;
  /** Round 2+: the client's answers to the conveyancer's queries. */
  answers?: Array<{ queryId: string; answer: string; evidenceDocumentIds: string[] }>;
  round?: number;
}

/** Typed facts for the rule layer (pipeline-#2-shaped: facts + confidence). */
export interface ProofOfFundsFacts {
  requestId: string;
  declarantName: string;
  purchasePricePennies: number | null;
  mortgageAdvancePennies: number | null;
  /** price − mortgage: what the client has to find (null when the price is unknown). */
  requiredPennies: number | null;
  totalDeclaredPennies: number;
  shortfallPennies: number | null;
  sources: Array<{ kind: FundSourceKind; amountPennies: number; description: string; evidenceCount: number; gift: FundSource['gift']; overseas: FundSource['overseas'] }>;
  giftedPennies: number;
  declarations: ProofOfFundsSubmission['declarations'];
  confidence: number;
  /** Round number (1 = first submission). */
  round: number;
}

export function factsFromSubmission(requestId: string, sub: ProofOfFundsSubmission, knownPricePennies: number | null): ProofOfFundsFacts {
  const price = sub.purchasePricePennies ?? knownPricePennies;
  const mortgage = sub.mortgageAdvancePennies ?? sub.sources.filter((s) => s.kind === 'mortgage').reduce((n, s) => n + s.amountPennies, 0) ?? null;
  const nonMortgage = sub.sources.filter((s) => s.kind !== 'mortgage');
  const total = nonMortgage.reduce((n, s) => n + s.amountPennies, 0);
  const required = price != null ? Math.max(0, price - (mortgage ?? 0)) : null;
  return {
    requestId,
    declarantName: sub.declarant.fullName,
    purchasePricePennies: price,
    mortgageAdvancePennies: mortgage,
    requiredPennies: required,
    totalDeclaredPennies: total,
    shortfallPennies: required != null ? Math.max(0, required - total) : null,
    sources: sub.sources.map((s) => ({ kind: s.kind, amountPennies: s.amountPennies, description: s.description, evidenceCount: s.evidenceDocumentIds.length + (s.gift?.donorEvidenceDocumentIds.length ?? 0), gift: s.gift ?? null, overseas: s.overseas ?? null })),
    giftedPennies: sub.sources.filter((s) => s.kind === 'gift').reduce((n, s) => n + s.amountPennies, 0),
    declarations: sub.declarations,
    // The client typed it; there is no extraction uncertainty. 1 unless the form is internally inconsistent.
    confidence: 1,
    round: sub.round ?? 1,
  };
}

export const gbp = (p: number): string => `£${(p / 100).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

/**
 * The deterministic part. Every flag is a fact about the declaration, never a judgement:
 * the conveyancer decides what each means for this client.
 */
export function evaluateProofOfFunds(f: ProofOfFundsFacts): Verdict {
  const flags: Flag[] = [];
  const d = f.declarations;
  if (!d.accurate || !d.noThirdPartyInterest || !d.noUndisclosedBorrowing) {
    flags.push({ code: 'POF_DECLARATION_INCOMPLETE', severity: 'high', description: `The client did not confirm: ${[!d.accurate && 'the information is complete and accurate', !d.noThirdPartyInterest && 'no third party has an interest', !d.noUndisclosedBorrowing && 'no undisclosed borrowing'].filter(Boolean).join('; ')}.`, locator: { section: 'Declarations' } });
  }
  if (f.sources.length === 0) flags.push({ code: 'POF_NO_SOURCES', severity: 'high', description: 'No source of funds was declared.', locator: { section: 'Sources' } });
  if (f.shortfallPennies != null && f.shortfallPennies > 0) {
    flags.push({ code: 'POF_SHORTFALL', severity: 'high', description: `Declared funds (${gbp(f.totalDeclaredPennies)}) fall short of the ${gbp(f.requiredPennies ?? 0)} needed after the mortgage advance by ${gbp(f.shortfallPennies)}.`, locator: { section: 'Totals' } });
  }
  if (f.requiredPennies == null) flags.push({ code: 'POF_PRICE_UNKNOWN', severity: 'low', description: 'The purchase price is not on file, so the declared total cannot be checked against what is needed.', locator: { section: 'Totals' } });
  f.sources.forEach((s, i) => {
    const where = { section: `Source ${i + 1}: ${FUND_SOURCE_LABEL[s.kind]}` };
    if (s.amountPennies > 0 && s.evidenceCount === 0) flags.push({ code: `POF_NO_EVIDENCE:${s.kind.toUpperCase()}`, severity: 'medium', description: `${FUND_SOURCE_LABEL[s.kind]} of ${gbp(s.amountPennies)} has no supporting document attached.`, locator: where });
    if (s.kind === 'gift') {
      const g = s.gift;
      if (!g) flags.push({ code: 'POF_GIFT_NO_DONOR', severity: 'high', description: `A gift of ${gbp(s.amountPennies)} was declared without donor details.`, locator: where });
      else {
        flags.push({ code: 'POF_GIFT', severity: 'medium', description: `Gifted deposit of ${gbp(s.amountPennies)} from ${g.donorName} (${g.donorRelationship}). Donor ID, a gift letter and the donor's statements are required, and the lender must be told.`, locator: where });
        if (g.repayable) flags.push({ code: 'POF_GIFT_REPAYABLE', severity: 'high', description: `The "gift" from ${g.donorName} is stated to be repayable: it is a loan, which the lender must approve and which may affect affordability.`, locator: where });
        if (g.donorAbroad) flags.push({ code: 'POF_GIFT_DONOR_ABROAD', severity: 'medium', description: `The donor (${g.donorName}) is outside the UK: identity and source of the donor's funds need extra care.`, locator: where });
        if (g.donorEvidenceDocumentIds.length === 0) flags.push({ code: 'POF_GIFT_NO_DONOR_EVIDENCE', severity: 'medium', description: `No donor documents (ID, gift letter, statements) attached for the gift from ${g.donorName}.`, locator: where });
      }
    }
    if (HIGH_RISK_SOURCES.has(s.kind)) flags.push({ code: `POF_HIGH_RISK:${s.kind.toUpperCase()}`, severity: 'high', description: `${FUND_SOURCE_LABEL[s.kind]} (${gbp(s.amountPennies)}) is a higher-risk source under the firm's AML policy: enhanced due diligence questions apply.${s.kind === 'overseas' && s.overseas ? ` Country: ${s.overseas.country}; ${s.overseas.alreadyInUk ? 'already in a UK account' : 'not yet transferred to the UK'}.` : ''}`, locator: where });
    if (s.kind === 'loan') flags.push({ code: 'POF_LOAN', severity: 'high', description: `A loan of ${gbp(s.amountPennies)} forms part of the funds: the mortgage lender must be told and may decline.`, locator: where });
  });
  if (flags.length) return { outcome: 'flag', flags, reasons: flags.map((x) => x.code) };
  return { outcome: 'clear', reasons: ['every source evidenced', 'no gift, loan or higher-risk source', f.shortfallPennies === 0 ? 'declared funds cover the balance' : 'price not checked'] };
}

/** The declaration rendered as the source document the decision cites (what the conveyancer opens). */
export function renderDeclaration(f: ProofOfFundsFacts, sub: ProofOfFundsSubmission, evidenceNames: Record<string, string>): string {
  const lines: string[] = [];
  lines.push('PROOF OF FUNDS DECLARATION', `Request: ${f.requestId}`, `Declarant: ${sub.declarant.fullName}${sub.declarant.email ? ` <${sub.declarant.email}>` : ''}${sub.declarant.phone ? ` ${sub.declarant.phone}` : ''}`, `Submitted: ${sub.submittedAt}`, '');
  lines.push('TOTALS');
  lines.push(`Purchase price: ${f.purchasePricePennies != null ? gbp(f.purchasePricePennies) : 'not stated'}`);
  lines.push(`Mortgage advance: ${f.mortgageAdvancePennies != null ? gbp(f.mortgageAdvancePennies) : 'none / not stated'}`);
  lines.push(`Balance the client must find: ${f.requiredPennies != null ? gbp(f.requiredPennies) : 'unknown'}`);
  lines.push(`Declared (excluding mortgage): ${gbp(f.totalDeclaredPennies)}`);
  if (f.shortfallPennies != null) lines.push(`Shortfall: ${gbp(f.shortfallPennies)}`);
  lines.push('');
  lines.push('SOURCES');
  sub.sources.forEach((s, i) => {
    lines.push(`Source ${i + 1}: ${FUND_SOURCE_LABEL[s.kind]} — ${gbp(s.amountPennies)}`);
    lines.push(`  ${s.description}`);
    if (s.bankName || s.accountHolder) lines.push(`  Account: ${[s.bankName, s.accountHolder].filter(Boolean).join(', ')}`);
    if (s.gift) lines.push(`  Gift from ${s.gift.donorName} (${s.gift.donorRelationship})${s.gift.donorAddress ? `, ${s.gift.donorAddress}` : ''}; repayable: ${s.gift.repayable ? 'YES' : 'no'}; donor abroad: ${s.gift.donorAbroad ? 'yes' : 'no'}`);
    if (s.overseas) lines.push(`  Overseas: ${s.overseas.country}; ${s.overseas.alreadyInUk ? 'already in a UK account' : 'not yet transferred'}`);
    const ev = [...s.evidenceDocumentIds, ...(s.gift?.donorEvidenceDocumentIds ?? [])];
    lines.push(`  Evidence attached: ${ev.length ? ev.map((id) => evidenceNames[id] ?? id).join('; ') : 'none'}`);
  });
  lines.push('');
  lines.push('DECLARATIONS');
  lines.push(`Complete and accurate: ${sub.declarations.accurate ? 'confirmed' : 'NOT confirmed'}`);
  lines.push(`No third-party interest: ${sub.declarations.noThirdPartyInterest ? 'confirmed' : 'NOT confirmed'}`);
  lines.push(`No undisclosed borrowing: ${sub.declarations.noUndisclosedBorrowing ? 'confirmed' : 'NOT confirmed'}`);
  if (sub.clientNote) lines.push('', 'CLIENT NOTE', sub.clientNote);
  return lines.join('\n');
}

/**
 * The deterministic briefing (what the conveyancer reads when the model is off, or its
 * output fails validation). Same shape as the AI one: totals, a row per source, the flags.
 */
export function templateBriefing(f: ProofOfFundsFacts, flags: Flag[], review?: TransactionReview | null, queries: PofQuery[] = []): string {
  const lines: string[] = [];
  if (f.round > 1) lines.push(`ROUND ${f.round}: the client has answered ${queries.filter((q) => q.status === 'answered').length} of ${queries.filter((q) => q.status !== 'withdrawn').length} queries (answers below).`, '');
  lines.push(`Proof of funds from ${f.declarantName}: ${f.sources.length} source${f.sources.length === 1 ? '' : 's'} declared totalling ${gbp(f.totalDeclaredPennies)}${f.requiredPennies != null ? ` against ${gbp(f.requiredPennies)} needed after the mortgage` : ''}${f.shortfallPennies ? ` — SHORTFALL ${gbp(f.shortfallPennies)}` : f.shortfallPennies === 0 ? ' — covers the balance' : ''}.`, '');
  f.sources.forEach((s, i) => {
    lines.push(`${i + 1}. ${FUND_SOURCE_LABEL[s.kind]} ${gbp(s.amountPennies)} — ${s.description}${s.evidenceCount ? ` (${s.evidenceCount} document${s.evidenceCount === 1 ? '' : 's'})` : ' (no documents)'}${s.gift ? ` — gift from ${s.gift.donorName}, ${s.gift.donorRelationship}${s.gift.repayable ? ', REPAYABLE' : ''}${s.gift.donorAbroad ? ', donor abroad' : ''}` : ''}`);
  });
  lines.push('');
  if (review?.statements.length) {
    lines.push('Statements read:');
    review.statements.forEach((st) => lines.push(`- ${st.fileName ?? st.documentId}: ${st.readable ? `${st.holder ?? 'holder not read'} · ${st.bank ?? ''} · ${st.from ?? '?'} to ${st.to ?? '?'} · ${st.transactions} transactions (${st.credits} credits) · closing ${st.closingPennies != null ? gbp(st.closingPennies) : 'not read'}` : 'NOT READABLE'}`));
    lines.push('');
  }
  if (flags.length) {
    lines.push('Points for your attention:');
    flags.forEach((fl, i) => lines.push(`${i + 1}. [${fl.severity.toUpperCase()}] ${fl.description}${fl.locator?.section ? ` (see ${fl.locator.section})` : ''}${FLAG_GUIDANCE[fl.code.split(':')[0]] ? `\n   ${FLAG_GUIDANCE[fl.code.split(':')[0]]}` : ''}`));
  } else {
    lines.push('Nothing flagged by the rules: every source is evidenced, the statements were read and show no unusual credits, there is no gift, loan or higher-risk source, and the declared funds cover the balance. Confirm the documents say what the client says they say.');
  }
  const open = queries.filter((q) => q.status === 'draft' || q.status === 'sent');
  const answered = queries.filter((q) => q.status === 'answered');
  if (answered.length) {
    lines.push('', 'Answers from the client:');
    answered.forEach((q) => lines.push(`- Q: ${q.question}\n  A: ${q.answer}${q.answerEvidenceDocumentIds.length ? ` (${q.answerEvidenceDocumentIds.length} document${q.answerEvidenceDocumentIds.length === 1 ? '' : 's'} attached)` : ''}`));
  }
  if (open.length) {
    lines.push('', `Queries drafted for the client (${open.length}) — "query" sends them; edit or withdraw any first:`);
    open.forEach((q, i) => lines.push(`${i + 1}. ${q.question}`));
  }
  lines.push('', `Risk rating from the flags: ${riskRating(flags).toUpperCase()}${riskRating(flags) === 'enhanced' ? ' — enhanced due diligence applies (record the additional measures taken).' : '.'}`);
  lines.push('Check in the source: the declaration and each attached document — statements must show the balance building up, not just a closing figure.');
  return lines.join('\n');
}

// ───────────────────────────── bank statements: transaction-level facts ─────────────────────────────

export interface StatementTransaction {
  /** ISO date. */
  date: string;
  description: string;
  /** Signed pennies: credits positive, debits negative. */
  amountPennies: number;
  /** Running balance after the transaction, if the statement shows it. */
  balancePennies?: number | null;
  /** The other party as printed (payer / payee / reference), if any. */
  counterparty?: string | null;
}

/** One bank statement (or a run of pages for one account) as the pipeline read it. */
export interface StatementFacts {
  accountHolder: string | null;
  bankName: string | null;
  /** Last four digits only — the full number is never extracted. */
  accountLast4: string | null;
  periodFrom: string | null;
  periodTo: string | null;
  openingBalancePennies: number | null;
  closingBalancePennies: number | null;
  transactions: StatementTransaction[];
  /** Regular salary / wages credits the extractor recognised (employer name as printed). */
  salaryCredits: Array<{ date: string; amountPennies: number; payer: string }>;
  confidence: number;
}

export interface EvidenceDocument {
  id: string;
  fileName: string | null;
  /** Which declared source (1-based index) it was attached to, or null for donor documents. */
  sourceIndex: number | null;
  donorFor: number | null;
  /** Present when the pipeline could read it as a statement; null for a gift letter, an ID, an unreadable scan. */
  statement: StatementFacts | null;
  /** The extractor's reason when a statement was expected and not read. */
  unreadable: string | null;
}

/**
 * The firm's source-of-funds policy — the numbers the rules use. An MLRO sets these; the
 * defaults are the conservative end of common practice (docs/proof-of-funds.md §3).
 */
export interface ProofOfFundsPolicy {
  /** A single credit at or above this is queried unless it is salary or a declared source. */
  largeCreditPennies: number;
  /** …or at or above this share of the amount declared for the source the statement supports. */
  largeCreditShareOfSource: number;
  /** Any cash / counter deposit at or above this is queried (below it, only if there are several). */
  cashDepositPennies: number;
  /** Several smaller cash deposits within the period are queried together (structuring). */
  cashDepositCount: number;
  /** A credit that leaves again (≥ this share of it) within N days looks like layering. */
  inAndOutDays: number;
  inAndOutShare: number;
  /** Statements must cover at least this many days ending within `staleDays` of the submission. */
  coverageDays: number;
  staleDays: number;
  /** Round-sum credits (multiples of this) at or above largeCreditPennies are noted. */
  roundSumPennies: number;
}

export const POF_POLICY: ProofOfFundsPolicy = {
  largeCreditPennies: 5_000_00,
  largeCreditShareOfSource: 0.2,
  cashDepositPennies: 1_000_00,
  cashDepositCount: 3,
  inAndOutDays: 10,
  inAndOutShare: 0.8,
  coverageDays: 90,
  staleDays: 45,
  roundSumPennies: 1_000_00,
};

/** Descriptions that mark a credit as cash. Bank wording varies; these are the common prints. */
const CASH_RE = /\b(cash|counter credit|cash dep|atm dep|paid in at|post office|branch dep|ctr credit|cash & dep)\b/i;
const CRYPTO_RE = /\b(coinbase|binance|kraken|crypto\.com|gemini|bitstamp|etoro|revolut crypto|bitcoin|btc|ethereum|luno|uphold|moonpay|paypal crypto)\b/i;
const GAMBLING_RE = /\b(bet365|betfair|william hill|paddy ?power|ladbrokes|coral|sky ?bet|betway|888|unibet|betfred|pokerstars|gala|foxy|tombola|lottery|national lottery|casino|bingo|bwin|virgin games|mecca)\b/i;
const OVERSEAS_RE = /\b(swift|iban|international|intl|inward payment|foreign|fx|wise|transferwise|western union|moneygram|remitly|worldremit|xe\.com|ofx|currencies direct|eur|usd|aed|inr|pkr|cny|hkd|sgd|aud|cad|zar|ngn)\b/i;
const SALARY_RE = /\b(salary|wages|payroll|bacs credit|pay|net pay|hmrc|dwp|universal credit|pension|child benefit)\b/i;
const LOAN_RE = /\b(loan|lending|finance|klarna|clearpay|zopa|ratesetter|funding circle|lendable|amigo|bamboo)\b/i;

const days = (a: string, b: string): number => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
const norm = (x: string | null | undefined): string => (x ?? '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
/** Does a printed name look like one of the known parties (holder, declarant, donor, employer)? Loose surname match. */
function looksLike(name: string | null | undefined, known: string[]): boolean {
  const n = norm(name);
  if (!n) return false;
  return known.some((k) => {
    const parts = norm(k).split(' ').filter((p) => p.length > 2);
    return parts.length > 0 && parts.some((p) => n.includes(p));
  });
}

/** A query the conveyancer puts to the client about one transaction (or one gap). Drafted by the rules, edited by a person. */
export interface DraftQuery {
  /** Stable within a submission: `<flagCode>:<docId>:<txIndex>` or `<flagCode>:<docId>`. */
  key: string;
  flagCode: string;
  documentId: string;
  transaction: StatementTransaction | null;
  question: string;
}

export interface TransactionReview {
  flags: Flag[];
  queries: DraftQuery[];
  /** Per-document coverage summary for the briefing. */
  statements: Array<{ documentId: string; fileName: string | null; holder: string | null; bank: string | null; from: string | null; to: string | null; transactions: number; credits: number; closingPennies: number | null; readable: boolean }>;
}

/**
 * The transaction-level review — what the guidance means by "scrutinise the statements":
 * every credit that is not obviously salary or a declared source is a question until it is
 * answered. Deterministic; every flag is a fact about a printed line, with the line quoted.
 */
export function reviewTransactions(facts: ProofOfFundsFacts, evidence: EvidenceDocument[], submittedAt: string, policy: ProofOfFundsPolicy = POF_POLICY): TransactionReview {
  const flags: Flag[] = [];
  const queries: DraftQuery[] = [];
  const statements: TransactionReview['statements'] = [];
  const knownParties = [facts.declarantName, ...facts.sources.flatMap((s) => [s.gift?.donorName ?? '', ...(s.description ? [] : [])])].filter(Boolean);
  const declaredEmployers = evidence.flatMap((e) => e.statement?.salaryCredits.map((c) => c.payer) ?? []);
  const push = (flag: Flag, q: DraftQuery | null) => {
    flags.push(flag);
    if (q) queries.push(q);
  };
  const cite = (doc: EvidenceDocument, t: StatementTransaction | null) => ({ section: `${doc.fileName ?? doc.id}${t ? ` · ${t.date} "${t.description}"` : ''}`, quote: t ? `${t.date} ${t.description} ${t.amountPennies >= 0 ? '+' : '−'}${gbp(Math.abs(t.amountPennies))}` : undefined });

  const statementDocs = evidence.filter((e) => e.statement || e.unreadable);
  for (const doc of statementDocs) {
    const st = doc.statement;
    if (!st) {
      statements.push({ documentId: doc.id, fileName: doc.fileName, holder: null, bank: null, from: null, to: null, transactions: 0, credits: 0, closingPennies: null, readable: false });
      push({ code: 'STATEMENT_UNREADABLE', severity: 'medium', description: `"${doc.fileName ?? doc.id}" could not be read as a bank statement (${doc.unreadable ?? 'no content'}). It has to be read by a person, or a clearer copy requested.`, locator: cite(doc, null) }, { key: `STATEMENT_UNREADABLE:${doc.id}`, flagCode: 'STATEMENT_UNREADABLE', documentId: doc.id, transaction: null, question: `We could not read "${doc.fileName ?? 'one of your documents'}". Please send a clear, complete copy (every page, all four corners visible) or the PDF download from your online banking.` });
      continue;
    }
    const source = doc.sourceIndex != null ? facts.sources[doc.sourceIndex - 1] ?? null : null;
    const donor = doc.donorFor != null ? facts.sources[doc.donorFor - 1]?.gift ?? null : null;
    const expectedHolders = donor ? [donor.donorName] : [facts.declarantName, source?.description ?? ''];
    const credits = st.transactions.filter((t) => t.amountPennies > 0);
    statements.push({ documentId: doc.id, fileName: doc.fileName, holder: st.accountHolder, bank: st.bankName, from: st.periodFrom, to: st.periodTo, transactions: st.transactions.length, credits: credits.length, closingPennies: st.closingBalancePennies, readable: true });

    // Whose account is this?
    if (st.accountHolder && !looksLike(st.accountHolder, expectedHolders.filter(Boolean))) {
      push({ code: 'HOLDER_MISMATCH', severity: 'high', description: `"${doc.fileName ?? doc.id}" is in the name of ${st.accountHolder}, which does not match ${donor ? `the donor (${donor.donorName})` : `the client (${facts.declarantName})`}.`, locator: cite(doc, null) }, { key: `HOLDER_MISMATCH:${doc.id}`, flagCode: 'HOLDER_MISMATCH', documentId: doc.id, transaction: null, question: `The statement "${doc.fileName ?? ''}" is in the name of ${st.accountHolder}. Please explain whose account this is and how the money in it relates to your purchase.` });
    }
    // Coverage: period length, recency, gaps.
    if (st.periodFrom && st.periodTo) {
      const covered = days(st.periodFrom, st.periodTo);
      const stale = days(st.periodTo, submittedAt.slice(0, 10));
      if (stale > policy.staleDays) push({ code: 'STATEMENT_STALE', severity: 'medium', description: `"${doc.fileName ?? doc.id}" ends on ${st.periodTo}, ${stale} days before the declaration; the balance today is not shown.`, locator: cite(doc, null) }, { key: `STATEMENT_STALE:${doc.id}`, flagCode: 'STATEMENT_STALE', documentId: doc.id, transaction: null, question: `Your statement for ${st.bankName ?? 'this account'} ends on ${st.periodTo}. Please send the statements from then up to today.` });
      if (covered < policy.coverageDays - 5 && !donor) push({ code: 'COVERAGE_SHORT', severity: 'low', description: `"${doc.fileName ?? doc.id}" covers ${covered} days (${st.periodFrom} to ${st.periodTo}); the firm's policy is ${policy.coverageDays} days.`, locator: cite(doc, null) }, null);
    }
    // Balance versus what this statement is supposed to prove.
    const targetPennies = donor ? (facts.sources[doc.donorFor! - 1]?.amountPennies ?? 0) : source?.amountPennies ?? 0;
    if (st.closingBalancePennies != null && targetPennies > 0 && st.closingBalancePennies < targetPennies && !(source && source.kind !== 'savings' && source.kind !== 'gift')) {
      push({ code: 'BALANCE_SHORT', severity: 'medium', description: `"${doc.fileName ?? doc.id}" closes at ${gbp(st.closingBalancePennies)} against ${gbp(targetPennies)} declared for ${donor ? 'the gift' : FUND_SOURCE_LABEL[source!.kind].toLowerCase()}.`, locator: cite(doc, null) }, { key: `BALANCE_SHORT:${doc.id}`, flagCode: 'BALANCE_SHORT', documentId: doc.id, transaction: null, question: `The closing balance on "${doc.fileName ?? 'this statement'}" is ${gbp(st.closingBalancePennies)}, but ${gbp(targetPennies)} was declared from this source. Where is the rest held? Please send the statement for that account.` });
    }
    // Savings declared "from salary" with no salary in sight.
    if (source?.kind === 'savings' && st.transactions.length >= 10 && st.salaryCredits.length === 0 && !st.transactions.some((t) => t.amountPennies > 0 && SALARY_RE.test(t.description))) {
      push({ code: 'NO_SALARY_CREDITS', severity: 'medium', description: `Savings of ${gbp(source.amountPennies)} are declared but "${doc.fileName ?? doc.id}" shows no salary or regular income credits in the period.`, locator: cite(doc, null) }, { key: `NO_SALARY_CREDITS:${doc.id}`, flagCode: 'NO_SALARY_CREDITS', documentId: doc.id, transaction: null, question: `Your savings are described as coming from salary, but we cannot see salary credits on "${doc.fileName ?? 'the statement'}". Which account is your salary paid into? Please send its last three months of statements.` });
    }

    // Line by line.
    let cashCount = 0;
    let cashTotal = 0;
    credits.forEach((t) => {
      const idx = st.transactions.indexOf(t);
      const key = (code: string) => `${code}:${doc.id}:${idx}`;
      const isSalary = st.salaryCredits.some((c) => c.date === t.date && c.amountPennies === t.amountPennies) || (SALARY_RE.test(t.description) && looksLike(t.counterparty ?? t.description, declaredEmployers));
      const large = t.amountPennies >= policy.largeCreditPennies || (targetPennies > 0 && t.amountPennies >= targetPennies * policy.largeCreditShareOfSource);
      const desc = `${t.date}: ${t.description} +${gbp(t.amountPennies)}`;
      if (CASH_RE.test(t.description)) {
        cashCount += 1;
        cashTotal += t.amountPennies;
        if (t.amountPennies >= policy.cashDepositPennies) push({ code: 'CASH_DEPOSIT', severity: 'high', description: `Cash paid in — ${desc}.`, locator: cite(doc, t) }, { key: key('CASH_DEPOSIT'), flagCode: 'CASH_DEPOSIT', documentId: doc.id, transaction: t, question: `On ${t.date} ${gbp(t.amountPennies)} was paid into your ${st.bankName ?? ''} account in cash ("${t.description}"). Where did this cash come from, and can you evidence it?` });
        return;
      }
      if (CRYPTO_RE.test(t.description) || CRYPTO_RE.test(t.counterparty ?? '')) {
        push({ code: 'CRYPTO_CREDIT', severity: 'high', description: `Credit from a cryptoasset exchange — ${desc}.`, locator: cite(doc, t) }, { key: key('CRYPTO_CREDIT'), flagCode: 'CRYPTO_CREDIT', documentId: doc.id, transaction: t, question: `On ${t.date} ${gbp(t.amountPennies)} arrived from what appears to be a cryptoasset exchange ("${t.description}"). Please send the exchange statements showing the original purchases, the sale, and the transfer to your bank, and tell us how the original investment was funded.` });
        return;
      }
      if (GAMBLING_RE.test(t.description) || GAMBLING_RE.test(t.counterparty ?? '')) {
        push({ code: 'GAMBLING_CREDIT', severity: 'high', description: `Credit from a gambling operator — ${desc}.`, locator: cite(doc, t) }, { key: key('GAMBLING_CREDIT'), flagCode: 'GAMBLING_CREDIT', documentId: doc.id, transaction: t, question: `On ${t.date} ${gbp(t.amountPennies)} was received from "${t.description}". Please explain this credit and send the operator's account history for the period.` });
        return;
      }
      if (OVERSEAS_RE.test(t.description) || OVERSEAS_RE.test(t.counterparty ?? '')) {
        push({ code: 'OVERSEAS_CREDIT', severity: large ? 'high' : 'medium', description: `Credit from overseas / a money-transfer service — ${desc}.`, locator: cite(doc, t) }, { key: key('OVERSEAS_CREDIT'), flagCode: 'OVERSEAS_CREDIT', documentId: doc.id, transaction: t, question: `On ${t.date} ${gbp(t.amountPennies)} arrived from abroad or via a transfer service ("${t.description}"). Who sent it, from which country, and how was the money earned or accumulated there? Please send the sending account's statement.` });
        return;
      }
      if (LOAN_RE.test(t.description) && large) {
        push({ code: 'LOAN_CREDIT', severity: 'high', description: `Credit that looks like a loan — ${desc}.`, locator: cite(doc, t) }, { key: key('LOAN_CREDIT'), flagCode: 'LOAN_CREDIT', documentId: doc.id, transaction: t, question: `On ${t.date} ${gbp(t.amountPennies)} arrived from "${t.description}", which looks like borrowing. Is any of the purchase money borrowed? If so, from whom and on what terms — your mortgage lender will need to know.` });
        return;
      }
      if (large && !isSalary) {
        const thirdParty = t.counterparty && !looksLike(t.counterparty, [...expectedHolders, ...knownParties].filter(Boolean));
        const round = t.amountPennies % policy.roundSumPennies === 0;
        const code = thirdParty ? 'THIRD_PARTY_CREDIT' : 'LARGE_CREDIT';
        push({ code, severity: thirdParty ? 'high' : 'medium', description: `${thirdParty ? `Large credit from a third party (${t.counterparty})` : 'Large credit'}${round ? ', round sum' : ''} — ${desc}.`, locator: cite(doc, t) }, { key: key(code), flagCode: code, documentId: doc.id, transaction: t, question: thirdParty ? `On ${t.date} ${gbp(t.amountPennies)} was received from ${t.counterparty}. Who is this, why did they pay you, and is any of it a gift or a loan towards the purchase?` : `On ${t.date} ${gbp(t.amountPennies)} was paid in ("${t.description}"). Where did this money come from? Please send evidence (the sending account's statement, a completion statement, a sale contract…).` });
        // In and out: the same money leaves again within days.
        const out = st.transactions.slice(idx + 1).find((u) => u.amountPennies < 0 && Math.abs(u.amountPennies) >= t.amountPennies * policy.inAndOutShare && days(t.date, u.date) <= policy.inAndOutDays);
        if (out) push({ code: 'IN_AND_OUT', severity: 'high', description: `The ${gbp(t.amountPennies)} received on ${t.date} left again on ${out.date} (${out.description}, ${gbp(Math.abs(out.amountPennies))}).`, locator: cite(doc, out) }, { key: key('IN_AND_OUT'), flagCode: 'IN_AND_OUT', documentId: doc.id, transaction: out, question: `${gbp(t.amountPennies)} came in on ${t.date} and ${gbp(Math.abs(out.amountPennies))} went out on ${out.date} ("${out.description}"). Please explain both movements.` });
      }
    });
    if (cashCount >= policy.cashDepositCount) push({ code: 'CASH_PATTERN', severity: 'high', description: `${cashCount} cash deposits totalling ${gbp(cashTotal)} on "${doc.fileName ?? doc.id}".`, locator: cite(doc, null) }, { key: `CASH_PATTERN:${doc.id}`, flagCode: 'CASH_PATTERN', documentId: doc.id, transaction: null, question: `Your ${st.bankName ?? ''} statement shows ${cashCount} cash deposits totalling ${gbp(cashTotal)}. Where does this cash come from? If it is from work or a business, please send the records that show it being earned.` });
    // Balance jump without visible income.
    if (st.openingBalancePennies != null && st.closingBalancePennies != null && st.closingBalancePennies - st.openingBalancePennies >= policy.largeCreditPennies * 2 && credits.every((t) => t.amountPennies < policy.largeCreditPennies) && st.salaryCredits.length === 0) {
      push({ code: 'BALANCE_JUMP', severity: 'medium', description: `"${doc.fileName ?? doc.id}" rises from ${gbp(st.openingBalancePennies)} to ${gbp(st.closingBalancePennies)} with no single large credit and no salary — many small credits.`, locator: cite(doc, null) }, { key: `BALANCE_JUMP:${doc.id}`, flagCode: 'BALANCE_JUMP', documentId: doc.id, transaction: null, question: `The balance on "${doc.fileName ?? 'this account'}" rose by ${gbp(st.closingBalancePennies - st.openingBalancePennies)} over the period through many smaller credits. What are they?` });
    }
  }

  // Declared sources with an amount but no statement that could be read for them.
  facts.sources.forEach((s, i) => {
    if (s.kind === 'mortgage' || s.amountPennies === 0) return;
    const readable = statementDocs.some((d) => d.sourceIndex === i + 1 && d.statement);
    const attached = evidence.some((d) => d.sourceIndex === i + 1);
    if (attached && !readable && !statementDocs.some((d) => d.sourceIndex === i + 1)) {
      push({ code: `NO_STATEMENT:${s.kind.toUpperCase()}`, severity: 'medium', description: `The documents attached for ${FUND_SOURCE_LABEL[s.kind].toLowerCase()} (${gbp(s.amountPennies)}) are not bank statements; the money itself has not been seen.`, locator: { section: `Source ${i + 1}` } }, { key: `NO_STATEMENT:${i + 1}`, flagCode: 'NO_STATEMENT', documentId: '', transaction: null, question: `For the ${gbp(s.amountPennies)} from ${FUND_SOURCE_LABEL[s.kind].toLowerCase()}, please send the bank statements for the account the money is in now, covering the last three months.` });
    }
  });
  return { flags, queries, statements };
}

/** A query as recorded on the log / projection. */
export interface PofQuery {
  id: string;
  key: string;
  flagCode: string;
  documentId: string | null;
  transaction: StatementTransaction | null;
  question: string;
  raisedAt: string;
  raisedBy: string;
  status: 'draft' | 'sent' | 'answered' | 'withdrawn';
  sentAt: string | null;
  answer: string | null;
  answerEvidenceDocumentIds: string[];
  answeredAt: string | null;
}

/** Enhanced due diligence is required by regulation in these situations (docs/proof-of-funds.md §4); the machine records the rating, the MLRO applies it. */
export const EDD_TRIGGER_CODES = ['POF_HIGH_RISK:CRYPTO', 'POF_HIGH_RISK:OVERSEAS', 'POF_HIGH_RISK:LOAN', 'POF_HIGH_RISK:BUSINESS_INCOME', 'POF_GIFT_DONOR_ABROAD', 'CRYPTO_CREDIT', 'GAMBLING_CREDIT', 'OVERSEAS_CREDIT', 'CASH_PATTERN', 'IN_AND_OUT', 'HOLDER_MISMATCH'] as const;

export type PofRiskRating = 'standard' | 'enhanced';
export function riskRating(flags: Flag[]): PofRiskRating {
  return flags.some((f) => (EDD_TRIGGER_CODES as readonly string[]).includes(f.code)) ? 'enhanced' : 'standard';
}

/** Standard flags → what is normally asked for (used by the template briefing and shown next to each flag). */
export const FLAG_GUIDANCE: Record<string, string> = {
  CASH_DEPOSIT: 'Cash is the highest-risk form of funds: the client must explain where it came from and evidence how it was earned or accumulated. Repeated cash deposits are a reason to consider the firm\'s reporting obligations.',
  CASH_PATTERN: 'Several cash deposits below any single threshold is the classic structuring pattern. Ask, record the answer, and consider whether the explanation is plausible against the client\'s known income.',
  THIRD_PARTY_CREDIT: 'Money from anyone other than the client is a third-party source: it needs its own source-of-funds evidence and, if it is a gift or a loan, the lender must be told.',
  LARGE_CREDIT: 'A large credit that is not salary or a declared source has to be explained and traced one step back (the sending account, a sale, a maturing policy).',
  IN_AND_OUT: 'Money that arrives and leaves within days is not savings; it may be a loan, a favour, or layering. The client must explain both legs.',
  CRYPTO_CREDIT: 'Cryptoassets are treated as higher risk by the guidance: the trail must run from the original purchase (and how that was funded) to the sale and the sterling transfer.',
  GAMBLING_CREDIT: 'Gambling winnings can be legitimate; the operator\'s account history should show the stakes and the wins, and the stakes must themselves be explained.',
  OVERSEAS_CREDIT: 'Funds from outside the UK need the sending account\'s statement and an explanation of how the money was earned there; high-risk third countries call for enhanced due diligence.',
  LOAN_CREDIT: 'Borrowed money changes the affordability picture and must be declared to the mortgage lender; an undisclosed loan is a common reason an offer is withdrawn.',
  HOLDER_MISMATCH: 'A statement in someone else\'s name is that person\'s money until shown otherwise: their identity and source of funds are needed.',
  STATEMENT_STALE: 'Source of funds must be current at the point money is received; ask for statements up to date.',
  STATEMENT_UNREADABLE: 'An unreadable document is no evidence; get a legible copy or the bank\'s PDF.',
  BALANCE_SHORT: 'The money declared must be visible in the accounts shown; ask where the balance is.',
  BALANCE_JUMP: 'A balance that grows through many small credits without salary needs explaining: a side business, rent, family support.',
  NO_SALARY_CREDITS: 'If savings come from salary, salary should be visible; otherwise the statement is not the account the savings came from.',
  NO_STATEMENT: 'A gift letter or an ID is not proof of funds; the money has to be seen in an account.',
  COVERAGE_SHORT: 'Three months is the usual minimum; less may be acceptable with a reason, and the MLRO decides.',
  QUERY_UNANSWERED: 'A query the client has not answered leaves the flag open; sign-off is not available until every query is answered or withdrawn.',
};
