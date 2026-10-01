/**
 * Readings become typed issues (docs/eventualities/README.md theme C; property.md J1, J4, J7; exchange.md J2).
 *
 * The title, lease, search and contract readers produce flags on one review decision; that says the
 * document was read. What a specific finding needs done (a second trustee, a consent, an indemnity
 * decided before the covenantee is approached, a lender told) is an issue of its own kind, with its
 * gate and its ways out. These rules pick out the findings that change what the file needs, the same
 * way the TA6 reader does: facts, cited verbatim, the kind named; the conveyancer decides.
 *
 * Each finding carries a `code`. The machine raises a finding once per case: a later reading of the
 * same document (a new edition, the lease read after the register) never raises it again.
 */
import type { IssueGate, IssueKind, IssueSeverity } from './issues';
import type { ContractFacts, Flag, LeaseFacts, SearchFacts, TitleFacts } from './types';

export interface Finding { code: string; kind: IssueKind; title: string; detail: string; severity: IssueSeverity; gate: IssueGate; page: number | null }
export interface FindingContext {
  side: 'buyer' | 'seller' | 'owner';
  hasLender: boolean;
  /** The seller's answers about works done (TA6 section 4), to cross-read against covenants. */
  alterations?: string | null;
  /** How many clients we act for (a sole owner selling under a Form A restriction needs a second trustee). */
  clients?: number;
  /** The purchase price, for the deposit percentage. */
  pricePennies?: number | null;
}

const clip = (s: string, n = 160) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length <= n ? t : `${t.slice(0, n - 1).replace(/[,;:.\s]+$/, '')}…`; };
const pageOf = (l?: { page?: number } | null) => l?.page ?? null;
const pounds = (p: number) => `£${(p / 100).toLocaleString('en-GB', { maximumFractionDigits: 2 })}`;
/** A creditor's or a tax charge (not a mortgage lender's): not discharged by an ordinary redemption. */
const NON_LENDER_CHARGE = /charging order|hm revenue|hmrc|inland revenue|secretary of state|legal aid|legal services commission|council|local authority|judgment|inhibition|bankrupt|trustee in bankruptcy/i;

/** The register. */
export function titleFindings(t: TitleFacts, ctx: FindingContext): Finding[] {
  if (t.planOnly) return [];
  const out: Finding[] = [];
  const ours = ctx.side === 'seller' ? 'our client\'s title' : 'the title';
  for (const r of t.restrictions) {
    const text = r.text;
    // Form A is routine when every owner sells; it bites when one is left (the read does not list the proprietors, so: our own sole client).
    if (/no disposition by a sole proprietor/i.test(text) && ctx.side === 'seller' && (ctx.clients ?? 2) < 2) {
      out.push({ code: `RESTRICTION_FORM_A:${r.code}`, kind: 'title_restriction', severity: 'warning', gate: 'exchange', page: pageOf(r.locator), title: 'Form A restriction: a second trustee is needed', detail: `"${clip(text)}". The owners held as tenants in common and our client sells alone: the money must be paid to at least two trustees (LPA s.27). Appoint a second trustee by deed before exchange (with the death certificate if the other owner has died), and the buyer's solicitor will ask for both to sign the transfer.` });
    } else if (/certificate|consent|signed by|on behalf of/i.test(text) && !/proprietor of the (registered )?charge|chargee|mortgagee|\blender\b|\bbank\b|building society/i.test(text)) {
      out.push({ code: `RESTRICTION_CONSENT:${r.code}`, kind: 'title_restriction', severity: 'warning', gate: 'exchange', page: pageOf(r.locator), title: 'Restriction: a certificate or consent is needed to register the transfer', detail: `"${clip(text)}". The Land Registry rejects the transfer without it. Ask the seller's solicitor to obtain the certificate of compliance or consent (and its fee) for completion, and a deed of covenant if the restriction requires one.` });
    }
    if (/home rights|family law act/i.test(text)) out.push(homeRights(r.code, text, pageOf(r.locator)));
    if (/unilateral notice/i.test(text)) out.push(unilateral(r.code, text, pageOf(r.locator)));
  }
  for (const c of t.charges) {
    const text = c.text;
    if (/home rights|family law act/i.test(text)) { out.push(homeRights(c.code, text, pageOf(c.locator))); continue; }
    if (/unilateral notice/i.test(text)) { out.push(unilateral(c.code, text, pageOf(c.locator))); continue; }
    if (NON_LENDER_CHARGE.test(text)) {
      out.push({ code: `CHARGE_NON_LENDER:${c.code}`, kind: 'title_defect', severity: 'critical', gate: 'exchange', page: pageOf(c.locator), title: `A charge that is not a mortgage: ${clip(text, 90)}`, detail: `"${clip(text)}" on ${ours}. A creditor's or a tax charge is not discharged by an ordinary redemption: get a payoff figure and the creditor's agreement to release it from the proceeds, put it on the completion statement, and check the proceeds cover it (if they do not, the sale cannot complete as it stands).` });
    }
  }
  // A covenant against building or altering, where the seller says works were done.
  const works = ctx.alterations?.trim();
  if (works && !/^(none|no|n\/a|not applicable|nil)\.?$/i.test(works)) {
    for (const c of t.covenants) {
      if (!/alter|extension|extend|build|erect|structure|without (the )?(prior )?(written )?consent|plans? (first )?approved/i.test(c.text)) continue;
      out.push({ code: `COVENANT_BREACH:${c.code}`, kind: 'restrictive_covenant', severity: 'warning', gate: 'exchange', page: pageOf(c.locator), title: 'Covenant against building or alterations, and works were done', detail: `The covenant "${clip(c.text)}" and the seller's forms list works: "${clip(works, 120)}". Decide between an indemnity policy and the covenantee's consent BEFORE anyone approaches the covenantee: contacting them voids most policies.${ctx.hasLender ? ' Tell the lender which.' : ''}` });
      break;
    }
  }
  return out;
}

const homeRights = (code: string, text: string, page: number | null): Finding => ({ code: `HOME_RIGHTS:${code}`, kind: 'title_defect', severity: 'critical', gate: 'exchange', page, title: 'Home rights notice on the register', detail: `"${clip(text)}". A spouse or civil partner has registered home rights (Family Law Act 1996). They must release them (or the notice is cancelled on form HR4 with their consent) before exchange; vacant possession cannot be given while it stands.` });
const unilateral = (code: string, text: string, page: number | null): Finding => ({ code: `UNILATERAL_NOTICE:${code}`, kind: 'title_defect', severity: 'warning', gate: 'exchange', page, title: 'Unilateral notice on the register', detail: `"${clip(text)}". Someone claims an interest in the property. The notice must be removed (form UN4 by the beneficiary) or the claim dealt with before exchange.` });

/** The lease (from the lease itself, or the leasehold title). */
export function leaseFindings(flags: Flag[], l: LeaseFacts | null, ctx: FindingContext): Finding[] {
  const out: Finding[] = [];
  const lender = ctx.hasLender ? ' Tell the lender.' : '';
  for (const f of flags) {
    const page = pageOf(f.locator);
    switch (f.code) {
      case 'LEASE_BELOW_LENDER_MINIMUM': out.push({ code: f.code, kind: 'short_lease', severity: 'critical', gate: 'exchange', page, title: 'Lease term below the lender\'s minimum', detail: `${f.description} Options: the seller serves the statutory notice to extend and assigns its benefit on completion, a negotiated extension before exchange, or a lender that accepts the term.` }); break;
      case 'SHORT_LEASE': out.push({ code: f.code, kind: 'short_lease', severity: (l?.unexpiredYears ?? 99) < 80 ? 'critical' : 'warning', gate: 'exchange', page, title: `Short lease: ${l?.unexpiredYears ?? '?'} years left`, detail: `${f.description} Advise the client on the cost of extending (marriage value below 80 years) and resale.${lender}` }); break;
      case 'GROUND_RENT_DOUBLING': case 'GROUND_RENT_HIGH': if (!out.some((x) => x.kind === 'ground_rent_issue')) out.push({ code: 'GROUND_RENT', kind: 'ground_rent_issue', severity: f.code === 'GROUND_RENT_DOUBLING' ? 'critical' : 'warning', gate: 'exchange', page, title: f.code === 'GROUND_RENT_DOUBLING' ? 'Ground rent doubles on review' : 'Ground rent above the assured-tenancy threshold', detail: `${f.description} A deed of variation from the landlord is the usual cure; some lenders accept an indemnity.${lender}` }); break;
      case 'LEASE_ALIENATION_ABSOLUTE': out.push({ code: f.code, kind: 'lease_defect', severity: 'critical', gate: 'exchange', page, title: 'The lease bars assignment', detail: `${f.description} The flat cannot be sold on without the landlord's agreement: a deed of variation or the landlord's written licence before exchange.` }); break;
      case 'FORFEITURE_ON_BANKRUPTCY': out.push({ code: f.code, kind: 'lease_defect', severity: 'warning', gate: 'exchange', page, title: 'Forfeiture on the tenant\'s insolvency', detail: `${f.description} Most lenders will not lend on a lease that can be forfeited on insolvency (Lenders' Handbook): a deed of variation, or the lender's written acceptance.` }); break;
      case 'NO_BUILDINGS_INSURANCE': out.push({ code: f.code, kind: 'lease_defect', severity: 'warning', gate: 'exchange', page, title: 'No adequate insurance provision in the lease', detail: `${f.description} The building must be insured by the landlord, the management company or the tenant, in terms the lender accepts.${lender}` }); break;
      default: break;
    }
  }
  return out;
}

/** What a search entry needs, by its code (extraction.ts MIN_SEVERITY). */
const SEARCH_RULES: Record<string, { kind: IssueKind; severity: IssueSeverity; title: string; action: string }> = {
  PLANNING_ENFORCEMENT: { kind: 'planning_permission_missing', severity: 'critical', title: 'Planning enforcement on the property', action: 'Get the notice and its status from the seller and the council; a live enforcement notice is not covered by indemnity. The lender must be told.' },
  BREACH_OF_CONDITION: { kind: 'planning_permission_missing', severity: 'warning', title: 'Breach of a planning condition', action: 'Get the details; ask for the condition to be discharged or regularised, or an indemnity where the breach is old and unenforced.' },
  CONTAMINATED_LAND: { kind: 'environmental_risk', severity: 'critical', title: 'Contaminated land', action: 'Order the environmental consultant\'s further report; the lender must be told and may decline.' },
  FLOOD_RISK_HIGH: { kind: 'environmental_risk', severity: 'warning', title: 'High flood risk', action: 'Confirm buildings insurance is available on normal terms (Flood Re where it applies) before exchange; tell the lender.' },
  COMPULSORY_PURCHASE: { kind: 'search_adverse_entry', severity: 'critical', title: 'Compulsory purchase affecting the property', action: 'Get the order and its extent; advise the client in writing before exchange. The lender must be told.' },
  ROAD_PROPOSALS: { kind: 'search_adverse_entry', severity: 'warning', title: 'Road scheme near the property', action: 'Get the scheme\'s extent and timing; advise the client on the effect on value and enjoyment.' },
  ROAD_UNADOPTED: { kind: 'missing_easement', severity: 'warning', title: 'The road is not adopted', action: 'Check the title grants a right of way over it and says who maintains it; if not, a deed of grant, a maintenance covenant, or an indemnity. Tell the lender.' },
  FINANCIAL_CHARGE: { kind: 'search_adverse_entry', severity: 'warning', title: 'A financial charge registered by the council', action: 'The seller pays it off on completion: ask for the figure and an undertaking.' },
  DRAINAGE_NOT_CONNECTED: { kind: 'search_adverse_entry', severity: 'warning', title: 'Not connected to the public sewer', action: 'Find out how it drains (septic tank or treatment plant), its compliance since 2020, and any easements for the pipes; tell the lender.' },
  BUILD_OVER_AGREEMENT: { kind: 'search_adverse_entry', severity: 'warning', title: 'Building over a public sewer', action: 'Ask for the water company\'s build-over agreement; without it, an indemnity policy.' },
  CIL_LIABILITY: { kind: 'search_adverse_entry', severity: 'warning', title: 'Community Infrastructure Levy liability', action: 'Confirm the levy was paid or that an exemption applies; an unpaid levy can bind the land.' },
  MINING_AREA: { kind: 'environmental_risk', severity: 'warning', title: 'In a mining area', action: 'Order the mining report (CON29M); tell the lender if it shows a claim or a risk.' },
  CHANCEL_LIABILITY: { kind: 'search_adverse_entry', severity: 'info', title: 'Chancel repair liability risk', action: 'Since October 2013 only a notice on the register binds a buyer; check the register, and offer indemnity if the lender or client wants it.' },
};

/** A search result. Only the entries that need something done; the rest stay on the review. */
export function searchFindings(f: SearchFacts, ctx: FindingContext): Finding[] {
  if (ctx.side !== 'buyer') return [];
  const out: Finding[] = [];
  for (const fl of f.flags) {
    const rule = SEARCH_RULES[fl.code];
    if (!rule || rule.severity === 'info') continue;
    out.push({ code: `${f.searchType}:${fl.code}`, kind: rule.kind, severity: rule.severity, gate: 'exchange', page: pageOf(fl.locator), title: `${rule.title} (${f.searchType.replace(/_/g, ' ')} search)`, detail: `${clip(fl.description, 240)} ${rule.action}` });
  }
  return out;
}

/** The draft contract: the deposit and the special conditions that change the bargain. */
export function contractFindings(c: Pick<ContractFacts, 'pricePennies' | 'depositPennies' | 'depositHolder' | 'noticeToCompleteDays' | 'specialConditions'>, ctx: FindingContext): Finding[] {
  const out: Finding[] = [];
  const price = c.pricePennies ?? ctx.pricePennies ?? null;
  const buyer = ctx.side === 'buyer';
  if (price && c.depositPennies != null && c.depositPennies < Math.round(price / 10)) {
    const pct = Math.round((c.depositPennies / price) * 1000) / 10;
    out.push({ code: 'DEPOSIT_BELOW_10', kind: 'deposit_issue', severity: 'warning', gate: 'exchange', page: null, title: `Deposit of ${pounds(c.depositPennies)} is ${pct}% of the price`, detail: buyer ? 'Advise the client in writing: if they fail to complete, the balance up to 10% becomes payable at once and a seller who rescinds can claim the full 10% (SCS 6.8). Record their acceptance.' : 'Record the client\'s agreement to a deposit below 10%, and that the contract makes the balance up to 10% payable on the buyer\'s default.' });
  }
  if (buyer && c.depositHolder && /\bagent\b/i.test(c.depositHolder) && !/stakeholder/i.test(c.depositHolder)) {
    out.push({ code: 'DEPOSIT_AS_AGENT', kind: 'deposit_issue', severity: 'warning', gate: 'exchange', page: null, title: 'Deposit held as agent for the seller', detail: `The contract has the deposit held as agent ("${clip(c.depositHolder, 80)}"): it can be released to the seller at exchange and is unprotected if the seller defaults. Ask for stakeholder; if it stays, advise the client and record their acceptance.` });
  }
  if (c.noticeToCompleteDays != null && c.noticeToCompleteDays < 10) {
    out.push({ code: 'NOTICE_TO_COMPLETE_SHORT', kind: 'contract_term', severity: 'warning', gate: 'exchange', page: null, title: `Notice to complete shortened to ${c.noticeToCompleteDays} working days`, detail: 'The standard is 10 working days (SCS 6.8). A shorter notice gives the client less time to put things right after a missed completion: ask for the standard, or advise them in writing.' });
  }
  const TERMS: Array<[RegExp, string, string]> = [
    [/7\.2[^.]*(not apply|exclud|delet)|(exclud|delet)[^.]*7\.2|no compensation for late completion/i, 'Late-completion compensation excluded', 'The condition removes the contractual compensation for late completion (SCS 7.2). Report it to the client before they sign.'],
    [/no requisitions|shall not raise (any )?(requisitions|enquiries)|accept(s)? the (seller'?s )?title/i, 'No requisitions on title', 'The buyer is to accept the title without raising requisitions. Only acceptable once the title has been fully investigated and reported on.'],
    [/relied (solely )?on (its|his|her|their) own (survey|inspection)|sold as seen|in its (present|current) (state and )?condition/i, 'Sold as seen / buyer relies on its own survey', 'The seller excludes responsibility for the condition. Confirm the client has a survey and has read it before they sign.'],
    [/conditional (up)?on|subject to (planning|the grant of|obtaining)/i, 'Conditional contract', 'The contract depends on something happening (planning, a consent, a sale). Diarise the condition\'s long-stop date; neither side can rely on completion until it is met.'],
    [/indemnif(y|ies) the seller|buyer (shall|will) indemnify/i, 'The buyer gives an indemnity', 'The buyer takes on a liability of the seller\'s. Report its extent to the client before they sign.'],
  ];
  for (const sc of c.specialConditions ?? []) {
    for (const [re, title, detail] of TERMS) {
      if (!re.test(sc.text)) continue;
      if (out.some((x) => x.title === title)) continue;
      out.push({ code: `TERM:${title.toUpperCase().replace(/[^A-Z]+/g, '_')}`, kind: 'contract_term', severity: 'warning', gate: 'exchange', page: pageOf(sc.locator), title, detail: `Special condition ${sc.code}: "${clip(sc.text)}". ${detail}${ctx.hasLender && /survey|conditional|indemn/i.test(title) ? ' Tell the lender.' : ''}` });
    }
  }
  return out;
}
