/**
 * Source of funds analysis (docs/proof-of-funds.md §9): what the money on the statements says about
 * where the purchase money came from, set against what the client declared. It runs after the
 * line-by-line review (`reviewTransactions`) on the same evidence, which is either a statement the
 * client uploaded or an account connected by open banking (bank-verified, up to 24 months).
 *
 *   1. every transaction is given a category (income, benefits, own transfer, from the donor,
 *      solicitor, investment, cash, crypto, gambling, overseas, loan; debits likewise);
 *   2. regular income is found as streams (the same payer, most months, similar amounts);
 *   3. money moved between the client's own accounts is traced: a large credit whose matching
 *      debit is on another account the client gave us is explained, not queried;
 *   4. each declared source is matched against what the accounts show (evidenced, part-seen, not seen);
 *   5. the source-of-wealth rules: savings that predate the history, growth the income cannot
 *      explain, a named employer never seen, a gift not traced to the donor, the donor's own money
 *      arriving just before the gift, gambling spend, a new loan.
 *
 * Deterministic. Every flag is a fact about the lines, quotes them, and drafts the routine question
 * the conveyancer would ask (never suspicion: no tipping off). Thresholds are firm policy (SOF_POLICY).
 */
import { gbp, FUND_SOURCE_LABEL, samePerson, type DraftQuery, type EvidenceDocument, type ProofOfFundsFacts, type StatementTransaction } from './proof-of-funds';
import type { Flag } from './types';

export type TxCategory =
  | 'income' | 'benefits' | 'own_transfer' | 'from_donor' | 'solicitor' | 'investment' | 'refund'
  | 'cash' | 'crypto' | 'gambling' | 'overseas' | 'loan' | 'other_credit'
  | 'cash_withdrawal' | 'gambling_spend' | 'crypto_spend' | 'loan_repayment' | 'transfer_out' | 'spend';

export interface SofPolicy {
  /** A credit at or above this is "large" for tracing. */
  largeCreditPennies: number;
  /** Savings mostly already there when the history starts: the history is asked to reach further back… */
  predateShare: number;
  /** …but only when the history itself is at least this long (three months of statements always shows savings already there). */
  predateMinMonths: number;
  /** Growth the income, declared sources and own transfers do not account for, above this share of the growth, is queried. */
  unexplainedGrowthShare: number;
  /** An income stream: a payer seen in at least this many distinct months, amounts within this spread of their median. */
  incomeMinMonths: number;
  incomeSpread: number;
  /** A credit this share of the declared amount or more, from the matching kind of payer, evidences a source. */
  evidencedShare: number;
  /** The donor's own money: a non-income credit of this share of the gift, within this many days before it. */
  donorRecentShare: number;
  donorRecentDays: number;
  /** Gambling spend over the history above this monthly average, or this share of income, is noted. */
  gamblingMonthlyPennies: number;
  gamblingIncomeShare: number;
  /** A lender's first repayment within this many days of the declaration is a new loan. */
  newLoanDays: number;
  /** Own-transfer matching: same amount within this many days either side. */
  transferMatchDays: number;
}

export const SOF_POLICY: SofPolicy = {
  largeCreditPennies: 5_000_00,
  predateShare: 0.5,
  predateMinMonths: 12,
  unexplainedGrowthShare: 0.2,
  incomeMinMonths: 3,
  incomeSpread: 0.25,
  evidencedShare: 0.8,
  donorRecentShare: 0.5,
  donorRecentDays: 90,
  gamblingMonthlyPennies: 250_00,
  gamblingIncomeShare: 0.05,
  newLoanDays: 180,
  transferMatchDays: 3,
};

const SALARY_RE = /\b(salary|wages|payroll|net pay|bacs credit|pay\b)/i;
const BENEFITS_RE = /\b(dwp|hmrc|universal credit|child benefit|tax credit|pension credit|pip|esa|jsa|state pension)\b/i;
const SOLICITOR_RE = /\b(solicitors?|llp|conveyancing|conveyancers|law firm|legal|client a\/?c|client account|completion|executors?|estate of|probate)\b/i;
const INVEST_RE = /\b(vanguard|hargreaves|hl\b|aj bell|nutmeg|moneybox|fidelity|interactive investor|ii\.co|trading ?212|freetrade|wealthify|premium bonds|ns ?& ?i|nsi|isa|lisa|help to buy|pension|aviva|scottish widows|standard life|royal london|legal & general|annuity)\b/i;
const REFUND_RE = /\b(refund|reversal|returned|cashback|rebate)\b/i;
const CASH_RE = /\b(cash|counter credit|cash dep|atm dep|paid in at|post office|branch dep|ctr credit)\b/i;
const CASH_OUT_RE = /\b(atm|cash withdrawal|cashpoint|link atm)\b/i;
const CRYPTO_RE = /\b(coinbase|binance|kraken|crypto\.com|gemini|bitstamp|etoro|bitcoin|btc|ethereum|luno|uphold|moonpay)\b/i;
const GAMBLING_RE = /\b(bet365|betfair|william hill|paddy ?power|ladbrokes|coral|sky ?bet|betway|888|unibet|betfred|pokerstars|gala|foxy|tombola|lottery|casino|bingo|bwin|virgin games|mecca)\b/i;
const OVERSEAS_RE = /\b(swift|iban|international|intl|inward payment|foreign|wise|transferwise|western union|moneygram|remitly|worldremit|xe\.com|ofx|currencies direct)\b/i;
const LOAN_RE = /\b(loan|lending|finance|klarna|clearpay|laybuy|paypal credit|zopa|ratesetter|funding circle|lendable|amigo|bamboo|novuna|creation|hitachi capital|car finance)\b/i;
const TRANSFER_RE = /\b(transfer|tfr|trf|fps|faster payment|to a\/?c|from a\/?c|internal|savings)\b/i;

const norm = (x: string | null | undefined): string => (x ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const days = (a: string, b: string): number => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
const month = (d: string) => d.slice(0, 7);
const who = (t: StatementTransaction) => t.counterparty?.trim() || t.description;
/** The payer as a stable key: the counterparty, else the description without dates, references and numbers. */
const payerKey = (t: StatementTransaction) => norm(who(t)).replace(/\b\d+\b/g, '').replace(/\b(ref|reference|bacs|fps|credit|payment)\b/g, '').replace(/\s+/g, ' ').trim();

export interface Categorised { tx: StatementTransaction; category: TxCategory }

/** One line's category, from its description and payer and the people on the file. */
export function categorise(t: StatementTransaction, people: { client: string[]; donors: string[] }, incomePayers: Set<string>): TxCategory {
  const text = `${t.description} ${t.counterparty ?? ''}`;
  if (t.amountPennies < 0) {
    if (GAMBLING_RE.test(text)) return 'gambling_spend';
    if (CRYPTO_RE.test(text)) return 'crypto_spend';
    if (CASH_OUT_RE.test(text)) return 'cash_withdrawal';
    if (LOAN_RE.test(text)) return 'loan_repayment';
    if (TRANSFER_RE.test(text) || (t.counterparty && samePerson(t.counterparty, people.client))) return 'transfer_out';
    return 'spend';
  }
  if (CASH_RE.test(text)) return 'cash';
  if (CRYPTO_RE.test(text)) return 'crypto';
  if (GAMBLING_RE.test(text)) return 'gambling';
  if (t.counterparty && people.donors.length && samePerson(t.counterparty, people.donors)) return 'from_donor';
  if (t.counterparty && samePerson(t.counterparty, people.client)) return 'own_transfer';
  if (BENEFITS_RE.test(text)) return 'benefits';
  if (incomePayers.has(payerKey(t)) || SALARY_RE.test(text)) return 'income';
  if (SOLICITOR_RE.test(text)) return 'solicitor';
  if (INVEST_RE.test(text)) return 'investment';
  if (OVERSEAS_RE.test(text)) return 'overseas';
  if (LOAN_RE.test(text)) return 'loan';
  if (REFUND_RE.test(text)) return 'refund';
  return 'other_credit';
}

export interface IncomeStream { payer: string; months: number; medianPennies: number; first: string; last: string }

/** Regular income: the same payer in most months, at a similar amount. */
export function incomeStreams(txs: StatementTransaction[], policy: SofPolicy = SOF_POLICY): IncomeStream[] {
  const by = new Map<string, StatementTransaction[]>();
  for (const t of txs.filter((x) => x.amountPennies > 0 && !CASH_RE.test(x.description))) {
    const k = payerKey(t);
    if (!k) continue;
    by.set(k, [...(by.get(k) ?? []), t]);
  }
  const out: IncomeStream[] = [];
  for (const [, list] of by) {
    const amounts = list.map((t) => t.amountPennies).sort((a, b) => a - b);
    const median = amounts[Math.floor(amounts.length / 2)];
    const regular = list.filter((t) => Math.abs(t.amountPennies - median) <= median * policy.incomeSpread);
    const months = new Set(regular.map((t) => month(t.date))).size;
    if (months < policy.incomeMinMonths) continue;
    const dates = regular.map((t) => t.date).sort();
    out.push({ payer: who(regular[0]), months, medianPennies: median, first: dates[0], last: dates[dates.length - 1] });
  }
  return out.sort((a, b) => b.medianPennies * b.months - a.medianPennies * a.months);
}

export type SourceMatch = 'evidenced' | 'part_seen' | 'not_seen' | 'held' | 'not_applicable';
export interface AccountProfile {
  documentId: string;
  name: string;
  holder: string | null;
  bank: string | null;
  provenance: 'open_banking' | 'upload';
  from: string | null;
  to: string | null;
  months: number;
  openingPennies: number | null;
  closingPennies: number | null;
  income: IncomeStream[];
  totals: Partial<Record<TxCategory, number>>;
  forDonor: boolean;
}
export interface SofAnalysis {
  accounts: AccountProfile[];
  sources: Array<{ index: number; kind: string; amountPennies: number; match: SourceMatch; note: string }>;
  flags: Flag[];
  queries: DraftQuery[];
  /** Review flags/queries (by query key) explained by a matched transfer between the client's own accounts. */
  explainedKeys: string[];
  /** The analysis as text, for the declaration document the decision cites. */
  report: string;
}

/**
 * The analysis. `evidence` is every document read for the submission (statements with their facts,
 * uploads and connected accounts alike); `reviewKeys` are the queries the line-by-line review drafted,
 * so a credit explained by an own-account transfer can be taken back out.
 */
export function analyseSourceOfFunds(facts: ProofOfFundsFacts, evidence: EvidenceDocument[], submittedAt: string, policy: SofPolicy = SOF_POLICY, opts: { /** Accounts the line review already asked about the balance on: one question per point. */ balanceAskedOn?: ReadonlySet<string> } = {}): SofAnalysis {
  const flags: Flag[] = [];
  const queries: DraftQuery[] = [];
  const explainedKeys: string[] = [];
  const clientNames = [facts.declarantName, ...(facts.coDeclarants ?? []), ...facts.sources.map((s) => s.jointHolderName ?? '')].filter(Boolean);
  const donorNames = facts.sources.flatMap((s) => [s.gift?.donorName ?? '', s.gift?.jointDonorName ?? '']).filter(Boolean);
  const docs = evidence.filter((e) => e.statement && e.statement.transactions.length);
  const name = (d: EvidenceDocument) => d.fileName ?? d.statement?.bankName ?? d.id;
  const cite = (d: EvidenceDocument, t: StatementTransaction | null) => ({ section: `${name(d)}${t ? ` · ${t.date} "${t.description}"` : ''}`, quote: t ? `${t.date} ${t.description} ${t.amountPennies >= 0 ? '+' : '−'}${gbp(Math.abs(t.amountPennies))}` : undefined });
  const push = (f: Flag, q: DraftQuery | null) => { flags.push(f); if (q) queries.push(q); };

  // 1–2. Categories and income streams, per account.
  const accounts: AccountProfile[] = [];
  const cats = new Map<string, Categorised[]>();
  for (const d of docs) {
    const st = d.statement!;
    const streams = incomeStreams(st.transactions, policy);
    const payers = new Set(streams.map((s) => payerKey({ date: '', description: s.payer, amountPennies: 1, counterparty: s.payer })));
    const c = st.transactions.map((tx) => ({ tx, category: categorise(tx, { client: clientNames, donors: donorNames }, payers) }));
    cats.set(d.id, c);
    const totals: Partial<Record<TxCategory, number>> = {};
    for (const x of c) totals[x.category] = (totals[x.category] ?? 0) + x.tx.amountPennies;
    const from = st.periodFrom ?? st.transactions.map((t) => t.date).sort()[0] ?? null;
    const to = st.periodTo ?? st.transactions.map((t) => t.date).sort().slice(-1)[0] ?? null;
    accounts.push({ documentId: d.id, name: name(d), holder: st.accountHolder, bank: st.bankName, provenance: d.provenance ?? 'upload', from, to, months: from && to ? Math.max(1, Math.round(days(from, to) / 30.4)) : 0, openingPennies: st.openingBalancePennies, closingPennies: st.closingBalancePennies, income: streams, totals, forDonor: d.donorFor != null });
  }

  // 3. Own-account tracing: a large credit from the client's own name with a matching debit on another account we hold.
  for (const d of docs) {
    const mine = cats.get(d.id)!;
    mine.forEach(({ tx, category }, idx) => {
      if (tx.amountPennies < policy.largeCreditPennies || (category !== 'own_transfer' && category !== 'other_credit')) return;
      const match = docs.filter((o) => o.id !== d.id).flatMap((o) => (cats.get(o.id) ?? []).map((x) => ({ o, x }))).find(({ x }) => x.tx.amountPennies === -tx.amountPennies && Math.abs(days(x.tx.date, tx.date)) <= policy.transferMatchDays);
      if (match) {
        // Explained: the money came from another of the client's accounts we can see; the review's question about it is withdrawn.
        for (const code of ['LARGE_CREDIT', 'THIRD_PARTY_CREDIT']) explainedKeys.push(`${code}:${d.id}:${idx}`);
      } else if (category === 'own_transfer') {
        push({ code: 'OWN_ACCOUNT_NOT_PROVIDED', severity: 'medium', description: `${gbp(tx.amountPennies)} came in on ${tx.date} from another account in the client's name ("${tx.description}"); that account has not been provided.`, locator: cite(d, tx) }, { key: `OWN_ACCOUNT_NOT_PROVIDED:${d.id}:${idx}`, flagCode: 'OWN_ACCOUNT_NOT_PROVIDED', documentId: d.id, transaction: tx, question: `On ${tx.date} ${gbp(tx.amountPennies)} was moved in from another of your accounts ("${tx.description}"). Please connect that account too (or send its statements) so we can see where the money was built up.` });
        explainedKeys.push(`LARGE_CREDIT:${d.id}:${idx}`);
      }
    });
  }

  // 4–5. Each declared source against the accounts attached to it (and, for a gift, the donor's).
  const sources: SofAnalysis['sources'] = [];
  facts.sources.forEach((s, i) => {
    const index = i + 1;
    const own = docs.filter((d) => d.sourceIndex === index);
    const donors = docs.filter((d) => d.donorFor === index);
    const allClient = docs.filter((d) => d.donorFor == null);
    const lines = (ds: EvidenceDocument[]) => ds.flatMap((d) => (cats.get(d.id) ?? []).map((x) => ({ d, ...x })));
    const add = (match: SourceMatch, note: string) => sources.push({ index, kind: s.kind, amountPennies: s.amountPennies, match, note });
    if (s.kind === 'mortgage' || s.amountPennies === 0) return add('not_applicable', 'The lender pays this at completion.');

    if (s.kind === 'gift') {
      const received = lines(allClient).filter((x) => x.category === 'from_donor' && x.tx.amountPennies > 0);
      const receivedTotal = received.reduce((a, x) => a + x.tx.amountPennies, 0);
      const donorBalance = donors.map((d) => d.statement!.closingBalancePennies ?? 0).reduce((a, b) => a + b, 0);
      if (receivedTotal >= s.amountPennies * policy.evidencedShare) add('evidenced', `Received from ${s.gift?.donorName ?? 'the donor'}: ${received.map((x) => `${gbp(x.tx.amountPennies)} on ${x.tx.date}`).join(', ')}.`);
      else if (donors.length && donorBalance >= s.amountPennies * policy.evidencedShare) add('held', `Not yet transferred; held by ${s.gift?.donorName ?? 'the donor'} (${gbp(donorBalance)} across ${donors.length} account${donors.length === 1 ? '' : 's'}).`);
      else {
        add(received.length || donors.length ? 'part_seen' : 'not_seen', received.length ? `${gbp(receivedTotal)} of ${gbp(s.amountPennies)} seen from the donor.` : donors.length ? `The donor's accounts hold ${gbp(donorBalance)}, short of the gift.` : 'Neither the gift arriving nor the donor\'s own account has been seen.');
        if (!received.length && !donors.length) {
          push({ code: 'GIFT_NOT_EVIDENCED', severity: 'high', description: `A gift of ${gbp(s.amountPennies)} from ${s.gift?.donorName ?? 'a donor'} is declared, but neither its arrival in the client's account nor the donor's own account has been seen.`, locator: { section: `Source ${index}` } }, { key: `GIFT_NOT_EVIDENCED:${index}`, flagCode: 'GIFT_NOT_EVIDENCED', documentId: '', transaction: null, question: `For the gift of ${gbp(s.amountPennies)} from ${s.gift?.donorName ?? 'your donor'}: if it has been sent to you, please connect (or send statements for) the account it arrived in; if not yet, ${s.gift?.donorName ?? 'they'} will need to connect their own account (or send statements) showing the money.` });
        }
      }
      // The donor's own money: a non-income credit shortly before the gift (or before today, if not yet given).
      const giftDate = received[0]?.tx.date ?? submittedAt.slice(0, 10);
      for (const d of donors) {
        (cats.get(d.id) ?? []).forEach(({ tx, category }, idx) => {
          if (tx.amountPennies < s.amountPennies * policy.donorRecentShare || category === 'income' || category === 'benefits') return;
          const before = days(tx.date, giftDate);
          if (before < 0 || before > policy.donorRecentDays) return;
          push({ code: 'GIFT_DONOR_FUNDS_RECENT', severity: 'high', description: `${s.gift?.donorName ?? 'The donor'}'s account received ${gbp(tx.amountPennies)} on ${tx.date} ("${tx.description}"), ${before} days before the gift.`, locator: cite(d, tx) }, { key: `GIFT_DONOR_FUNDS_RECENT:${d.id}:${idx}`, flagCode: 'GIFT_DONOR_FUNDS_RECENT', documentId: d.id, transaction: tx, question: `${s.gift?.donorName ?? 'Your donor'}'s account shows ${gbp(tx.amountPennies)} arriving on ${tx.date} ("${tx.description}"), shortly before the gift. Please ask them where that money came from (for example a sale, savings moved from another account, or an inheritance) and send the evidence.` });
        });
      }
      return;
    }

    if (!own.length) return add('not_seen', 'No account attached for this source.');
    const ownLines = lines(own);
    const closing = own.reduce((a, d) => a + (d.statement!.closingBalancePennies ?? 0), 0);

    if (s.kind === 'savings') {
      add(closing >= s.amountPennies * policy.evidencedShare ? 'evidenced' : closing > 0 ? 'part_seen' : 'not_seen', `Held: ${gbp(closing)} against ${gbp(s.amountPennies)} declared.`);
      for (const d of own) {
        const st = d.statement!;
        const acct = accounts.find((a) => a.documentId === d.id)!;
        const opening = st.openingBalancePennies ?? null;
        // Mostly there already when the history starts: how was it built up?
        if (opening != null && opening >= s.amountPennies * policy.predateShare && acct.months >= policy.predateMinMonths) {
          push({ code: 'SAVINGS_PREDATE_HISTORY', severity: 'medium', description: `"${name(d)}" already held ${gbp(opening)} on ${acct.from}, the start of the ${acct.months}-month history: most of the declared savings predate it.`, locator: cite(d, null) }, { key: `SAVINGS_PREDATE_HISTORY:${d.id}`, flagCode: 'SAVINGS_PREDATE_HISTORY', documentId: d.id, transaction: null, question: `Your ${st.bankName ?? ''} account already held ${gbp(opening)} on ${acct.from}. Please tell us briefly how those savings were built up (for example from salary over which years, a previous property sale, an inheritance) and send any evidence you have, such as older statements.` });
        }
        // Growth over the history that income, own transfers and declared sources do not account for.
        // Only on lines that add up (opening + every line = closing): a partly read statement would make the gap up.
        const reconciles = opening != null && st.closingBalancePennies != null && Math.abs(opening + st.transactions.reduce((a, t) => a + t.amountPennies, 0) - st.closingBalancePennies) <= 100;
        if (reconciles && !opts.balanceAskedOn?.has(d.id) && opening != null && st.closingBalancePennies != null) {
          const growth = st.closingBalancePennies - opening;
          const c = cats.get(d.id) ?? [];
          const explained = c.filter((x) => ['income', 'benefits', 'own_transfer', 'from_donor', 'solicitor', 'investment', 'refund'].includes(x.category)).reduce((a, x) => a + x.tx.amountPennies, 0);
          const out = -c.filter((x) => x.tx.amountPennies < 0).reduce((a, x) => a + x.tx.amountPennies, 0);
          const unexplained = growth - (explained - out);
          if (growth >= policy.largeCreditPennies && unexplained > growth * policy.unexplainedGrowthShare) {
            push({ code: 'SAVINGS_GROWTH_UNEXPLAINED', severity: 'medium', description: `"${name(d)}" grew by ${gbp(growth)} over ${acct.months} months; income and known transfers account for ${gbp(Math.max(0, growth - unexplained))} of it.`, locator: cite(d, null) }, { key: `SAVINGS_GROWTH_UNEXPLAINED:${d.id}`, flagCode: 'SAVINGS_GROWTH_UNEXPLAINED', documentId: d.id, transaction: null, question: `Your ${st.bankName ?? ''} balance grew by ${gbp(growth)} over the period, more than the income we can see paid into it. Where did the rest come from? If money was moved in from another account, please connect or send that account too.` });
          }
        }
      }
      return;
    }

    // A lump sum from the matching kind of payer evidences the source; else it is noted and asked about.
    const wanted: Partial<Record<string, TxCategory[]>> = { sale_proceeds: ['solicitor'], inheritance: ['solicitor'], investment_sale: ['investment'], pension: ['investment'], remortgage_equity: ['solicitor', 'loan'], help_to_buy_isa: ['investment'], lifetime_isa: ['investment'], business_income: ['income', 'other_credit'], overseas: ['overseas'], crypto: ['crypto'], loan: ['loan'] };
    const kinds = wanted[s.kind];
    if (!kinds) return add(closing >= s.amountPennies * policy.evidencedShare ? 'evidenced' : 'part_seen', `Held: ${gbp(closing)}.`);
    const hits = ownLines.filter((x) => x.tx.amountPennies > 0 && kinds.includes(x.category));
    const total = hits.reduce((a, x) => a + x.tx.amountPennies, 0);
    if (total >= s.amountPennies * policy.evidencedShare) return add('evidenced', `Seen: ${hits.slice(0, 3).map((x) => `${gbp(x.tx.amountPennies)} on ${x.tx.date} from ${who(x.tx)}`).join('; ')}.`);
    if (closing >= s.amountPennies * policy.evidencedShare && ['investment_sale', 'pension', 'help_to_buy_isa', 'lifetime_isa'].includes(s.kind)) return add('held', `Held: ${gbp(closing)} (the account itself may be the ${FUND_SOURCE_LABEL[s.kind as keyof typeof FUND_SOURCE_LABEL]?.toLowerCase() ?? 'source'}).`);
    add(total > 0 ? 'part_seen' : 'not_seen', total > 0 ? `${gbp(total)} of ${gbp(s.amountPennies)} seen.` : 'Not seen arriving yet.');
    if (s.kind === 'sale_proceeds' || s.kind === 'inheritance') {
      const what = s.kind === 'sale_proceeds' ? 'the sale proceeds' : 'the inheritance';
      push({ code: `SOURCE_NOT_SEEN:${s.kind.toUpperCase()}`, severity: 'low', description: `${FUND_SOURCE_LABEL[s.kind as keyof typeof FUND_SOURCE_LABEL]} of ${gbp(s.amountPennies)}: no payment from a solicitor or estate is seen in the accounts attached.`, locator: { section: `Source ${index}` } }, { key: `SOURCE_NOT_SEEN:${index}`, flagCode: 'SOURCE_NOT_SEEN', documentId: '', transaction: null, question: `We cannot yet see ${what} (${gbp(s.amountPennies)}) arriving in the accounts you connected. If it has not been paid yet, please send ${s.kind === 'sale_proceeds' ? 'the completion statement from your sale solicitor' : "the estate accounts or the executor's letter"}; if it has, please connect or send the account it went into.` });
    }
  });

  // Across every client account: gambling spend and a new loan.
  const clientDocs = docs.filter((d) => d.donorFor == null);
  const allLines = clientDocs.flatMap((d) => (cats.get(d.id) ?? []).map((x) => ({ d, ...x })));
  const monthsSeen = Math.max(1, new Set(allLines.map((x) => month(x.tx.date))).size);
  const gambling = -allLines.filter((x) => x.category === 'gambling_spend').reduce((a, x) => a + x.tx.amountPennies, 0);
  const income = allLines.filter((x) => x.category === 'income' || x.category === 'benefits').reduce((a, x) => a + x.tx.amountPennies, 0);
  if (gambling > 0 && (gambling / monthsSeen >= policy.gamblingMonthlyPennies || (income > 0 && gambling >= income * policy.gamblingIncomeShare))) {
    const first = allLines.find((x) => x.category === 'gambling_spend')!;
    push({ code: 'GAMBLING_SPEND', severity: 'high', description: `${gbp(gambling)} paid to gambling operators over ${monthsSeen} months (${gbp(Math.round(gambling / monthsSeen))} a month${income ? `; ${Math.round((gambling / income) * 100)}% of the income seen` : ''}).`, locator: cite(first.d, first.tx) }, { key: 'GAMBLING_SPEND', flagCode: 'GAMBLING_SPEND', documentId: first.d.id, transaction: first.tx, question: `Your statements show regular payments to betting or gaming sites (${gbp(gambling)} over the period). Have any winnings contributed to the money for this purchase? If so, please send the operator's account history.` });
  }
  const repayments = allLines.filter((x) => x.category === 'loan_repayment');
  const byLender = new Map<string, typeof repayments>();
  for (const r of repayments) byLender.set(payerKey(r.tx), [...(byLender.get(payerKey(r.tx)) ?? []), r]);
  for (const [, list] of byLender) {
    const first = list.map((x) => x.tx.date).sort()[0];
    const historyStart = allLines.map((x) => x.tx.date).sort()[0];
    if (list.length < 2 || !first || !historyStart || days(historyStart, first) < 31 || days(first, submittedAt.slice(0, 10)) > policy.newLoanDays) continue;
    const x = list[0];
    push({ code: 'LOAN_RECENT', severity: 'medium', description: `Repayments to ${who(x.tx)} began on ${first} (${list.length} so far): a loan taken out recently.`, locator: cite(x.d, x.tx) }, { key: `LOAN_RECENT:${payerKey(x.tx)}`, flagCode: 'LOAN_RECENT', documentId: x.d.id, transaction: x.tx, question: `Your statements show repayments to ${who(x.tx)} starting on ${first}. What is this borrowing for? If any of it is going towards the purchase, your mortgage lender will need to know.` });
  }

  return { accounts, sources, flags, queries, explainedKeys, report: renderAnalysis(facts, accounts, sources) };
}

const CATEGORY_LABEL: Partial<Record<TxCategory, string>> = { income: 'Income', benefits: 'Benefits', own_transfer: 'From own accounts', from_donor: 'From the donor', solicitor: 'From solicitors', investment: 'From investments', cash: 'Cash paid in', crypto: 'From crypto', gambling: 'From gambling', overseas: 'From overseas', loan: 'Borrowed', other_credit: 'Other credits', gambling_spend: 'Gambling spend', loan_repayment: 'Loan repayments' };
const MATCH_LABEL: Record<SourceMatch, string> = { evidenced: 'Evidenced', part_seen: 'Part seen', not_seen: 'Not seen', held: 'Held, not yet moved', not_applicable: '—' };

/** The analysis as it reads in the declaration document: accounts, income, and each source against the evidence. */
export function renderAnalysis(facts: ProofOfFundsFacts, accounts: AccountProfile[], sources: SofAnalysis['sources']): string {
  if (!accounts.length && !sources.length) return '';
  const L: string[] = ['', 'SOURCE OF FUNDS ANALYSIS', ''];
  for (const a of accounts) {
    L.push(`${a.forDonor ? 'Donor account' : 'Account'}: ${a.name}${a.holder ? ` (${a.holder})` : ''}, ${a.provenance === 'open_banking' ? 'connected by open banking (bank-verified)' : 'uploaded statement'}, ${a.from ?? '?'} to ${a.to ?? '?'} (${a.months} month${a.months === 1 ? '' : 's'})${a.closingPennies != null ? `, balance ${gbp(a.closingPennies)}` : ''}.`);
    for (const s of a.income.slice(0, 3)) L.push(`  Income: ${s.payer}, about ${gbp(s.medianPennies)} in ${s.months} months (${s.first} to ${s.last}).`);
    const t = Object.entries(a.totals).filter(([k, v]) => CATEGORY_LABEL[k as TxCategory] && v).map(([k, v]) => `${CATEGORY_LABEL[k as TxCategory]} ${gbp(Math.abs(v as number))}`);
    if (t.length) L.push(`  ${t.join(' · ')}`);
  }
  if (sources.length) {
    L.push('', 'Declared against seen:');
    for (const s of sources) L.push(`  ${s.index}. ${FUND_SOURCE_LABEL[s.kind as keyof typeof FUND_SOURCE_LABEL] ?? s.kind} ${gbp(s.amountPennies)}: ${MATCH_LABEL[s.match]}. ${s.note}`);
  }
  void facts;
  return L.join('\n');
}
