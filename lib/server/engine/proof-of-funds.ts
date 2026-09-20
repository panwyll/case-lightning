/**
 * Proof of funds (source-of-funds / source-of-wealth) — the automated flow.
 *
 *   conveyancer fires the form  →  client completes it (public, tokenised link)  →
 *   typed facts  →  DETERMINISTIC rules produce the flags  →  the summariser writes the
 *   briefing (validated, template fallback)  →  ALWAYS a decision for the conveyancer:
 *   approve / request further (re-opens the form) / escalate / reject (manual handling).
 *
 * Nothing here decides anything. The rules say what is worth a person's attention
 * (a shortfall, an unevidenced source, a gift, a repayable "gift", a high-risk source);
 * the summary explains it; the conveyancer signs off — AML sign-off is a human act.
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
export function templateBriefing(f: ProofOfFundsFacts, flags: Flag[]): string {
  const lines: string[] = [];
  lines.push(`Proof of funds from ${f.declarantName}: ${f.sources.length} source${f.sources.length === 1 ? '' : 's'} declared totalling ${gbp(f.totalDeclaredPennies)}${f.requiredPennies != null ? ` against ${gbp(f.requiredPennies)} needed after the mortgage` : ''}${f.shortfallPennies ? ` — SHORTFALL ${gbp(f.shortfallPennies)}` : f.shortfallPennies === 0 ? ' — covers the balance' : ''}.`, '');
  f.sources.forEach((s, i) => {
    lines.push(`${i + 1}. ${FUND_SOURCE_LABEL[s.kind]} ${gbp(s.amountPennies)} — ${s.description}${s.evidenceCount ? ` (${s.evidenceCount} document${s.evidenceCount === 1 ? '' : 's'})` : ' (no documents)'}${s.gift ? ` — gift from ${s.gift.donorName}, ${s.gift.donorRelationship}${s.gift.repayable ? ', REPAYABLE' : ''}${s.gift.donorAbroad ? ', donor abroad' : ''}` : ''}`);
  });
  lines.push('');
  if (flags.length) {
    lines.push('Points for your attention:');
    flags.forEach((fl, i) => lines.push(`${i + 1}. [${fl.severity.toUpperCase()}] ${fl.description}${fl.locator?.section ? ` (see ${fl.locator.section})` : ''}`));
  } else {
    lines.push('Nothing flagged by the rules: every source is evidenced, there is no gift, loan or higher-risk source, and the declared funds cover the balance. Confirm the documents say what the client says they say.');
  }
  lines.push('', 'Check in the source: the declaration and each attached document — statements must show the balance building up, not just a closing figure.');
  return lines.join('\n');
}
