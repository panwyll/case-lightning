/**
 * Cross-checks (Document Review Engine, part 3): the same fact appears in more than one
 * document and on the case record, and the register compares them. Deterministic rules
 * over register keys, run after every read; a disagreement is an issue with every value
 * and where each came from, which is the single most useful thing a reviewer is handed.
 *
 * Pure: `crossCheck` takes the case record and the register rows and returns verdicts.
 * The runner in pg-documents.ts persists them and raises or resolves the issue.
 */
export interface RegisterRow { documentId: string; documentLabel: string; key: string; value: string; page: number | null }
export interface CaseRecord {
  propertyAddress: string | null;
  purchasePricePennies: number | null;
  buyerNames: string[];
  sellerNames: string[];
  lender: string | null;
  completionDate: string | null;
  /** Documented name changes (marriage, deed poll): a document naming the old name names the same person. */
  nameAliases?: Array<{ from: string; to: string }>;
}
export type CheckId = 'address' | 'title_number' | 'price' | 'buyer_names' | 'seller_names' | 'lender' | 'completion_date' | 'ground_rent' | 'landlord';
export interface CheckValue { source: string; documentId: string | null; value: string; page: number | null }
export interface CheckResult {
  check: CheckId;
  label: string;
  status: 'match' | 'mismatch' | 'gap';
  values: CheckValue[];
  message: string;
}

const CHECK_LABEL: Record<CheckId, string> = { address: 'Property address', title_number: 'Title number', price: 'Price', buyer_names: "Buyer's names", seller_names: "Seller's names", lender: 'Lender', completion_date: 'Completion date', ground_rent: 'Ground rent', landlord: 'Landlord' };

/** Keys in the register that carry each fact. The suffix is what every extractor writes; the prefix says which document. */
const KEYS: Record<CheckId, RegExp> = {
  address: /\.(address|property_description)$/,
  title_number: /\.title_number$|^title\.number$/,
  price: /\.price_pennies$/,
  buyer_names: /^(contract\.buyer|offer\.borrower|id\.subject)\.\d+$/,
  seller_names: /^(contract\.seller|title\.proprietor)\.\d+$/,
  lender: /^(offer\.lender|contract\.lender)$/,
  completion_date: /\.completion_date$/,
  ground_rent: /^(lease|pack)\.ground_rent_pennies_pa$/,
  landlord: /^(lease|pack)\.landlord$/,
};

const POSTCODE = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/i;
export const normAddress = (s: string): { postcode: string | null; number: string | null; text: string } => {
  const pc = s.match(POSTCODE);
  const postcode = pc ? `${pc[1]}${pc[2]}`.toUpperCase() : null;
  const num = s.trim().match(/^(?:flat\s+\w+,?\s*)?(\d+[a-z]?)\b/i);
  return { postcode, number: num ? num[1].toLowerCase() : null, text: s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() };
};
const TITLES = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'sir', 'dame', 'lord', 'lady', 'rev']);
export const normName = (s: string): { surname: string; initial: string; tokens: string[] } => {
  const tokens = s.toLowerCase().replace(/[^a-z' -]+/g, ' ').split(/\s+/).filter((t) => t && !TITLES.has(t.replace('.', '')));
  return { surname: tokens[tokens.length - 1] ?? '', initial: tokens[0]?.[0] ?? '', tokens };
};
const namesMatch = (a: string, b: string) => { const x = normName(a); const y = normName(b); return !!x.surname && x.surname === y.surname && (!x.initial || !y.initial || x.initial === y.initial); };
const normTitleNo = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
const normLender = (s: string) => s.toLowerCase().replace(/\b(plc|ltd|limited|the|bank|building society|bs)\b/g, '').replace(/[^a-z]+/g, ' ').trim();
const normDate = (s: string) => { const d = new Date(s); return Number.isNaN(d.getTime()) ? s.trim() : d.toISOString().slice(0, 10); };
export const parsePennies = (s: string): number | null => { const m = s.replace(/[£,\s]/g, '').match(/^(\d+)(?:\.(\d{1,2}))?$/); return m ? Number(m[1]) * 100 + Number((m[2] ?? '0').padEnd(2, '0')) : null; };

export function crossCheck(record: CaseRecord, rows: RegisterRow[]): CheckResult[] {
  const out: CheckResult[] = [];
  const pick = (id: CheckId) => rows.filter((r) => KEYS[id].test(r.key)).map<CheckValue>((r) => ({ source: r.documentLabel, documentId: r.documentId, value: r.value, page: r.page }));
  const finish = (check: CheckId, values: CheckValue[], agree: (a: CheckValue, b: CheckValue) => boolean, show: (v: CheckValue) => string = (v) => v.value) => {
    if (values.length < 2) return; // nothing to compare against yet
    const first = values[0];
    const odd = values.filter((v) => !agree(first, v));
    // A value that disagrees with the first may still agree with a majority; mismatch means at least two distinct groups.
    const groups: CheckValue[][] = [];
    for (const v of values) { const g = groups.find((gg) => agree(gg[0], v)); if (g) g.push(v); else groups.push([v]); }
    const status: CheckResult['status'] = groups.length > 1 ? 'mismatch' : 'match';
    const message = status === 'match'
      ? `${CHECK_LABEL[check]} agrees across ${values.length} sources.`
      : `${CHECK_LABEL[check]} differs: ${groups.map((g) => `${show(g[0])} (${g.map((v) => v.source).join(', ')})`).join(' vs ')}.`;
    out.push({ check, label: CHECK_LABEL[check], status, values, message: odd.length || status === 'match' ? message : message });
  };

  const caseVal = (value: string | null | undefined): CheckValue[] => (value ? [{ source: 'Case record', documentId: null, value, page: null }] : []);

  finish('address', [...caseVal(record.propertyAddress), ...pick('address')], (a, b) => {
    const x = normAddress(a.value); const y = normAddress(b.value);
    if (x.postcode && y.postcode) return x.postcode === y.postcode && (!x.number || !y.number || x.number === y.number);
    return x.text.includes(y.text) || y.text.includes(x.text);
  });
  finish('title_number', pick('title_number'), (a, b) => normTitleNo(a.value) === normTitleNo(b.value));
  // Price keys end in _pennies and the case record is in pennies too: compare as integers, show as pounds.
  finish('price', [...caseVal(record.purchasePricePennies != null ? String(record.purchasePricePennies) : null), ...pick('price')], (a, b) => Number(a.value) === Number(b.value), (v) => (Number.isFinite(Number(v.value)) ? `£${(Number(v.value) / 100).toLocaleString('en-GB')}` : v.value));
  finish('lender', [...caseVal(record.lender), ...pick('lender')], (a, b) => normLender(a.value) === normLender(b.value));
  finish('completion_date', [...caseVal(record.completionDate), ...pick('completion_date')], (a, b) => normDate(a.value) === normDate(b.value));
  // Leasehold: what the lease says against what the pack says.
  finish('ground_rent', pick('ground_rent'), (a, b) => Number(a.value) === Number(b.value), (v) => (Number.isFinite(Number(v.value)) ? `£${(Number(v.value) / 100).toLocaleString('en-GB')} a year` : v.value));
  finish('landlord', pick('landlord'), (a, b) => normLender(a.value) === normLender(b.value) || namesMatch(a.value, b.value));

  // Names: every document's list against the case record's list; a document may name a subset (one borrower of two).
  const nameCheck = (check: CheckId, recordNamesIn: string[], docRows: CheckValue[]) => {
    if (!recordNamesIn.length || !docRows.length) return;
    // A documented change of name: the former name is the same person as the record's name.
    const recordNames = [...recordNamesIn, ...(record.nameAliases ?? []).filter((a) => recordNamesIn.some((n) => namesMatch(n, a.to) || namesMatch(n, a.from))).flatMap((a) => [a.from, a.to])];
    const byDoc = new Map<string, CheckValue[]>();
    for (const v of docRows) (byDoc.get(v.source) ?? byDoc.set(v.source, []).get(v.source)!).push(v);
    const values: CheckValue[] = [{ source: 'Case record', documentId: null, value: recordNames.join(' & '), page: null }];
    const bad: string[] = [];
    for (const [src, vals] of byDoc) {
      values.push({ source: src, documentId: vals[0].documentId, value: vals.map((v) => v.value).join(' & '), page: vals[0].page });
      const unknown = vals.filter((v) => !recordNames.some((n) => namesMatch(n, v.value)));
      if (unknown.length) bad.push(`${src} names ${unknown.map((u) => u.value).join(' & ')}`);
    }
    out.push({ check, label: CHECK_LABEL[check], status: bad.length ? 'mismatch' : 'match', values, message: bad.length ? `${CHECK_LABEL[check]} differ from the case record (${recordNames.join(' & ')}): ${bad.join('; ')}.` : `${CHECK_LABEL[check]} agree across ${values.length} sources.` });
  };
  nameCheck('buyer_names', record.buyerNames, pick('buyer_names'));
  nameCheck('seller_names', record.sellerNames, pick('seller_names'));
  return out;
}
