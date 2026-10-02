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
import type { ContractFacts, Flag, LeaseFacts, MortgageOfferFacts, SearchFacts, TitleFacts } from './types';

export interface Finding { code: string; kind: IssueKind; title: string; detail: string; severity: IssueSeverity; gate: IssueGate; page: number | null }
export interface FindingContext {
  side: 'buyer' | 'seller' | 'owner';
  hasLender: boolean;
  /** The seller's answers about works done (TA6 section 4), to cross-read against covenants. */
  alterations?: string | null;
  /** How many clients we act for (a sole owner selling under a Form A restriction needs a second trustee). */
  clients?: number;
  /** When the mortgage offer runs out, for a completion date fixed in the draft. */
  offerExpiry?: string | null;
  /** The purchase price, for the deposit percentage. */
  pricePennies?: number | null;
  /** The seller's forms say access or services are shared (TA6), to check against the rights on the register. */
  sharedAccess?: boolean;
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
  // A court order against the property or an owner (parties.md 2.13): a freezing or restraint order, or a pending land action.
  for (const e of [...t.restrictions, ...t.charges, ...(t.notices ?? [])]) {
    if (/freezing order|restraint order|proceeds of crime|pending (land )?action|lis pendens|writ or order|order affecting land/i.test(e.text)) out.push({ code: `COURT_ORDER:${e.code}`, kind: 'title_restriction', severity: 'critical', gate: 'exchange', page: pageOf((e as { locator?: unknown }).locator as never), title: `A court order or pending action is registered: ${clip(e.text, 80)}`, detail: `"${clip(e.text)}". Get a copy of the order or the claim and check it permits this ${ctx.side === 'seller' ? 'sale' : 'transaction'}; the party who registered it consents in writing and applies to cancel the entry (or the court varies the order) before exchange. A freezing or restraint order breached is contempt of court.` });
  }
  for (const c of t.charges) {
    const text = c.text;
    if (/home rights|family law act/i.test(text)) { out.push(homeRights(c.code, text, pageOf(c.locator))); continue; }
    if (/unilateral notice/i.test(text)) { out.push(unilateral(c.code, text, pageOf(c.locator))); continue; }
    if (NON_LENDER_CHARGE.test(text)) {
      out.push({ code: `CHARGE_NON_LENDER:${c.code}`, kind: 'title_defect', severity: 'critical', gate: 'exchange', page: pageOf(c.locator), title: `A charge that is not a mortgage: ${clip(text, 90)}`, detail: `"${clip(text)}" on ${ours}. A creditor's or a tax charge is not discharged by an ordinary redemption: get a payoff figure and the creditor's agreement to release it from the proceeds, put it on the completion statement, and check the proceeds cover it (if they do not, the sale cannot complete as it stands).` });
    }
  }
  // The class of title: anything but absolute is a defect a lender must accept (LRA ss.9-10; property.md 1.2).
  if (t.titleClass === 'possessory' || t.titleClass === 'qualified') out.push({ code: `TITLE_CLASS:${t.titleClass}`, kind: 'title_defect', severity: 'critical', gate: 'exchange', page: null, title: `${t.titleClass === 'possessory' ? 'Possessory' : 'Qualified'} title, not absolute`, detail: `The title is ${t.titleClass}: the registry does not guarantee it against claims ${t.titleClass === 'possessory' ? 'existing at first registration' : 'it names'}. Routes: a defective title indemnity policy, an application to upgrade (possessory can be upgraded after 12 years, LRA s.62), or a lender that accepts it in writing.` });
  if (t.titleClass === 'good_leasehold' && ctx.hasLender) out.push({ code: 'TITLE_CLASS:good_leasehold', kind: 'lender_approval', severity: 'warning', gate: 'exchange', page: null, title: 'Good leasehold title: the lender must accept it', detail: "The landlord's title was not examined at registration. Most lenders want an indemnity policy unless their Part 2 accepts good leasehold; ask." });
  // Notices in the charges register (property.md 1.9).
  for (const n of t.notices ?? []) {
    if (/home rights|family law act/i.test(n.text)) out.push(homeRights(n.code, n.text, pageOf(n.locator)));
    else if (/unilateral notice/i.test(n.text)) out.push(unilateral(n.code, n.text, pageOf(n.locator)));
    else if (/agreed notice|notice of (an )?(option|lease|deed|agreement|right)/i.test(n.text)) out.push({ code: `NOTICE:${n.code}`, kind: 'third_party_encumbrance', severity: 'warning', gate: 'exchange', page: pageOf(n.locator), title: 'A notice on the register binds the buyer', detail: `"${clip(n.text)}". Get the document it protects and report its effect (an option, an overage, a lease, a right of way) before exchange.` });
  }
  // Form A on a purchase from a sole surviving proprietor: the buyer pays two trustees or takes subject to the beneficiaries' interests.
  if (ctx.side === 'buyer' && (t.proprietors ?? []).length === 1 && t.restrictions.some((r) => /no disposition by a sole proprietor/i.test(r.text))) out.push({ code: 'RESTRICTION_FORM_A:purchase', kind: 'title_restriction', severity: 'warning', gate: 'exchange', page: null, title: 'Form A restriction, and only one proprietor: two trustees must sign', detail: `${t.proprietors![0]} is the only proprietor of a title held in shares. Ask the seller's solicitor for a second trustee to be appointed (with the death certificate if a co-owner has died) so the money is paid to two trustees and the buyer takes free of the shares (LPA s.27).` });
  if (ctx.side === 'buyer') { const risk = sellerIdentityRisk(t); if (risk) out.push(risk); }
  // The seller has owned it under six months (a back-to-back sale): lenders want to know, and the price uplift is a fraud marker (parties.md 9.4).
  if (ctx.side === 'buyer' && t.proprietorSince && Date.now() - Date.parse(t.proprietorSince) < 182 * 86_400_000) out.push({ code: 'OWNED_UNDER_SIX_MONTHS', kind: 'lender_approval', severity: 'warning', gate: 'exchange', page: null, title: `The seller has owned it only since ${t.proprietorSince}`, detail: `A sale within six months of the seller buying${t.pricePaidPennies ? ` (they paid ${pounds(t.pricePaidPennies)})` : ''}. Tell the lender (most want to know, and some will not lend), ask the seller's solicitor why, and compare the price with what was paid: a large uplift without works is a marker of mortgage fraud.` });
  // What else the register says (property.md 1.3, 1.8, 1.11, 1.17-1.19; 8.3).
  const every = [...t.restrictions, ...t.charges, ...t.covenants, ...(t.notices ?? []), ...(t.propertyEntries ?? [])];
  const seen = new Set<string>();
  const once = (code: string, f: Omit<Finding, 'code'>) => { if (!seen.has(code)) { seen.add(code); out.push({ code, ...f }); } };
  for (const e of every) {
    const x = e.text, pg = pageOf(e.locator);
    if (/pre-?emption|right of first refusal|overage|clawback|option to (purchase|buy)|section 157|housing act 1985|right to buy/i.test(x)) once(`ENCUMBRANCE_RIGHT:${e.code}`, { kind: 'third_party_encumbrance', severity: 'warning', gate: 'exchange', page: pg, title: `A third party's right over the land: ${clip(x, 70)}`, detail: `"${clip(x)}". A pre-emption or option must be released or the notice served and expired; an overage is a sum payable on a later sale or planning permission (work out whether this sale triggers it, and what is due); a Right to Buy restriction needs the landlord's certificate. Tell the lender.` });
    if (/rent ?charge/i.test(x)) once('RENTCHARGE', { kind: 'third_party_encumbrance', severity: ctx.hasLender ? 'critical' : 'warning', gate: 'exchange', page: pg, title: 'A rentcharge on the land', detail: `"${clip(x)}". The owner of a rentcharge can take possession or grant a lease if it is unpaid (LPA 1925 s.121). Ask for the last receipt, a deed of variation excluding s.121 or an indemnity policy; a plain rentcharge can be redeemed under the Rentcharges Act 1977. Lenders' Part 2 usually requires this before exchange.` });
    if (/chancel/i.test(x)) once('CHANCEL_NOTICE', { kind: 'search_adverse_entry', severity: 'warning', gate: 'exchange', page: pg, title: 'Chancel repair liability is registered', detail: `"${clip(x)}". A registered notice binds the buyer: an indemnity policy is not normally available once a liability is known; ask the parochial church council for the amount and history, advise the client, and tell the lender.` });
    if (/mines and minerals|minerals? (are |is )?(excepted|reserved)|manorial/i.test(x)) once('MINES_MANORIAL', { kind: 'third_party_encumbrance', severity: 'info', gate: 'none', page: pg, title: 'Mines and minerals or manorial rights are excepted', detail: `"${clip(x)}". Someone else may own what is under the land or have manorial rights over it. Tell the client; a mining search where the area calls for it; an indemnity on request; tell the lender if its Part 2 asks.` });
    if (/positive covenant|to (maintain|repair|contribute)|contribut\w* (to|towards) the (cost|expense)|indemnity covenant|deed of covenant/i.test(x)) once('POSITIVE_COVENANT', { kind: 'restrictive_covenant', severity: 'warning', gate: 'exchange', page: pg, title: 'Positive covenants that pass with the land', detail: `"${clip(x)}". Positive covenants do not bind a buyer automatically: the transfer must contain an indemnity covenant (the chain of indemnity), and a deed of covenant with the estate or management company may be required, with its fee on the statement.` });
    if (!t.restrictions.includes(e) && /estate (management|rent ?charge|charge)|management company|maintenance charge/i.test(x)) once('ESTATE_CHARGE', { kind: 'third_party_encumbrance', severity: 'warning', gate: 'exchange', page: pg, title: 'Estate charges or a management company', detail: `"${clip(x)}". Tell the client what is payable and to whom; get the company's pack (the charge, arrears); a deed of covenant to the company on completion; and check any estate rentcharge excludes LPA s.121.` });
  }
  // A leasehold house (property.md 7.13): the right to buy the freehold, estate charges, the lender's view.
  if (t.tenure === 'leasehold' && /\b(house|bungalow|cottage|semi-detached|detached|terraced)\b/i.test(t.propertyDescription ?? '') && !/\bflat|maisonette|apartment\b/i.test(t.propertyDescription ?? '')) once('LEASEHOLD_HOUSE', { kind: 'lease_defect', severity: 'warning', gate: 'exchange', page: null, title: 'A leasehold house', detail: 'Advise the client on buying the freehold (Leasehold Reform Act 1967, and the 2024 Act reforms as they come in), the ground rent and any permission fees, and resale. Many lenders restrict lending on leasehold houses: check the Part 2.' });
  // A lease extension or variation in progress (property.md 7.12): it completes before ours.
  for (const p of t.pendingApplications ?? []) if (/variation|extension|new lease|surrender/i.test(p)) once('PENDING_LEASE_CHANGE', { kind: 'lease_defect', severity: 'warning', gate: 'exchange', page: null, title: `The lease is being changed: ${clip(p, 70)}`, detail: 'A lease extension or deed of variation is pending at HM Land Registry. It must be registered before we complete (or the benefit of a section 42 notice assigned to the buyer with the contract), and the lender told what it lends on.' });
  for (const p of t.pendingApplications ?? []) once(`PENDING:${p.slice(0, 20)}`, { kind: 'title_defect', severity: 'warning', gate: 'exchange', page: null, title: `An application is pending at HM Land Registry: ${clip(p, 70)}`, detail: `"${clip(p)}". Ask the seller's solicitor what it is and when it will complete; exchange waits until it is registered (or the official copies are downloaded again after it), so the title being bought is the title shown.` });
  if (t.editionDate && Date.now() - Date.parse(t.editionDate) > 30 * 86_400_000) once('STALE_COPIES', { kind: 'title_defect', severity: 'info', gate: 'none', page: null, title: `The official copies are dated ${t.editionDate}`, detail: 'Download fresh official copies before the report on title and again before exchange: anything registered since will not show on these.' });
  { const gap = accessGap(t, ctx); if (gap) out.push(gap); }
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

/**
 * Seller impersonation red flags from the register (parties.md 9.2; Dreamvar v Mishcon, P&P v Owen White): an
 * unencumbered property whose owner gives an address elsewhere (worse, abroad), held for many years. Two or more and
 * the buyer's firm must ask how the seller's solicitor verified their client before any money goes.
 */
export function sellerIdentityRisk(t: TitleFacts): Finding | null {
  if (t.planOnly) return null;
  const postcode = (s: string | null | undefined) => s?.toUpperCase().match(/\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/)?.slice(1, 3).join(' ') ?? null;
  const here = postcode(t.propertyDescription);
  const flags: string[] = [];
  if (!t.charges.some((c) => /\b(charge|mortgage)\b/i.test(c.text) && !/home rights|notice/i.test(c.text))) flags.push('no mortgage on the title');
  const addrs = t.proprietorAddresses ?? [];
  if (addrs.length && here && !addrs.some((a) => postcode(a) === here)) flags.push("the owner's address for service is not the property");
  if (addrs.some((a) => !postcode(a) && /\b(spain|france|usa|united states|australia|canada|dubai|uae|germany|italy|portugal|ireland|hong kong|singapore|india|china|nigeria|south africa)\b/i.test(a))) flags.push('the owner gives an address abroad');
  if (t.proprietorSince && Date.now() - Date.parse(t.proprietorSince) > 10 * 365.25 * 86_400_000) flags.push(`owned since ${t.proprietorSince.slice(0, 4)}`);
  if (flags.length < 2) return null;
  return { code: 'SELLER_IDENTITY_RISK', kind: 'seller_identity_risk', severity: 'warning', gate: 'exchange', page: null, title: `Seller identity red flags: ${flags.join(', ')}`, detail: `These are the marks of the properties fraudsters sell by impersonating the owner. Before any money goes: ask the seller's solicitor how they verified their client's identity and that they are the registered owner (and when they were instructed), check the firm on the SRA register, and keep the reply on file.` };
}

const homeRights = (code: string, text: string, page: number | null): Finding => ({ code: `HOME_RIGHTS:${code}`, kind: 'title_defect', severity: 'critical', gate: 'exchange', page, title: 'Home rights notice on the register', detail: `"${clip(text)}". A spouse or civil partner has registered home rights (Family Law Act 1996). They must release them (or the notice is cancelled on form HR4 with their consent) before exchange; vacant possession cannot be given while it stands.` });
const unilateral = (code: string, text: string, page: number | null): Finding => ({ code: `UNILATERAL_NOTICE:${code}`, kind: 'title_defect', severity: 'warning', gate: 'exchange', page, title: 'Unilateral notice on the register', detail: `"${clip(text)}". Someone claims an interest in the property. The notice must be removed (form UN4 by the beneficiary) or the claim dealt with before exchange.` });

/** Shared access or services on the forms, and no right over the neighbouring land on the register (property.md 1.12, 1.13). */
export function accessGap(t: TitleFacts, ctx: FindingContext): Finding | null {
  if (!ctx.sharedAccess || ctx.side !== 'buyer' || t.planOnly) return null;
  const rights = [...t.covenants, ...(t.propertyEntries ?? [])].some((e) => /right of way|rights? to pass|easement|together with|the right (to|of)|drain|services|access/i.test(e.text));
  if (rights) return null;
  return { code: 'MISSING_EASEMENT', kind: 'missing_easement', severity: 'warning', gate: 'exchange', page: null, title: 'Shared access or services, and no right on the register', detail: `The seller's forms say the access, a drive or the services are shared or cross other land, but the register shows no right of way or easement for them. Ask the seller's solicitor for the deed granting it; failing that, a statutory declaration of 20 years' use (prescription) with an indemnity policy. For an unadopted road, the right of way and who pays for upkeep.${ctx.hasLender ? ' Tell the lender.' : ''}` };
}

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
  // What the lease leaves out (property.md 7.3): no one repairing the structure, no insurance covenant.
  if (l && l.repairs != null && !/structure|main walls|roof|foundations|exterior/i.test(l.repairs)) out.push({ code: 'LEASE_NO_STRUCTURE_REPAIR', kind: 'lease_defect', severity: 'warning', gate: 'exchange', page: null, title: 'The lease does not say who repairs the structure', detail: `"${clip(l.repairs)}". Most lenders require the landlord (or a management company) to repair the structure, the roof and the common parts, with the cost recoverable through the service charge. Options: a deed of variation, a missing-covenant indemnity policy, or a variation under LTA 1987 s.35.${lender}` });
  if (l && l.insurance != null && !l.insurance.trim() && !out.some((x) => x.code === 'NO_BUILDINGS_INSURANCE')) out.push({ code: 'LEASE_NO_INSURANCE_COVENANT', kind: 'lease_defect', severity: 'warning', gate: 'exchange', page: null, title: 'The lease has no insurance covenant', detail: `No one is obliged to insure the building. A deed of variation or an indemnity policy; the lender's Part 2 decides.${lender}` });
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
  LISTED_BUILDING: { kind: 'planning_permission_missing', severity: 'warning', title: 'A listed building', action: 'Every alteration the seller lists is checked against the listed building consent history: works without consent are a criminal offence with no time limit, and no indemnity policy covers them. Tell the lender; advise the client that future works need consent.' },
  S106_AGREEMENT: { kind: 'search_adverse_entry', severity: 'warning', title: 'A section 106 agreement', action: 'Get the agreement: an affordable-housing or occupancy restriction can limit who may buy or lend, and payments under it may be outstanding. Check the lender accepts it.' },
  STOP_NOTICE: { kind: 'planning_permission_missing', severity: 'critical', title: 'A stop notice', action: 'Get the notice: the activity it names must stop. An indemnity is not available once the council is involved. Advise the client in writing; this may end the purchase.' },
  PRIVATE_WATER_SUPPLY: { kind: 'environmental_risk', severity: 'warning', title: 'A private water supply', action: 'A recent water quality test, the council\'s risk assessment, an easement for any pipe across other land, and the lender told.' },
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

/** A conditional contract's long-stop date, where a condition names one ("conditional on ... by 31 March 2027"). */
export function conditionalLongStop(conditions: Array<{ text: string }>): string | null {
  const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  for (const c of conditions) {
    if (!/conditional|long[- ]?stop|subject to (planning|the grant|obtaining)/i.test(c.text)) continue;
    const iso = c.text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
    if (iso) return iso[0];
    const m = c.text.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})\b/i);
    if (m) return `${m[3]}-${String(MONTHS.indexOf(m[2].toLowerCase()) + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  return null;
}

/** The draft contract: the deposit and the special conditions that change the bargain. */
export function contractFindings(c: Pick<ContractFacts, 'pricePennies' | 'depositPennies' | 'depositHolder' | 'noticeToCompleteDays' | 'specialConditions'> & { completionDate?: string | null; chattelsPricePennies?: number | null; fixturesListPresent?: boolean | null }, ctx: FindingContext): Finding[] {
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
  // A completion date already in the draft that the mortgage offer does not reach (exchange.md 2.8).
  if (buyer && c.completionDate && ctx.offerExpiry && c.completionDate.slice(0, 10) > ctx.offerExpiry.slice(0, 10)) {
    out.push({ code: 'COMPLETION_AFTER_OFFER', kind: 'mortgage_offer_expiring', severity: 'critical', gate: 'exchange', page: null, title: `The draft completion date (${c.completionDate.slice(0, 10)}) is after the mortgage offer expires (${ctx.offerExpiry.slice(0, 10)})`, detail: 'Ask the lender to extend the offer, or agree an earlier date with the seller, before exchange: the date becomes contractual and the advance will not be released after the offer ends.' });
  }
  // Chattels (exchange.md 2.6): SDLT is on the land only, so HMRC looks at the split, harder when it takes the price under a threshold.
  if (buyer && c.chattelsPricePennies && price) {
    const land = price - c.chattelsPricePennies;
    const crosses = [12_500_000, 25_000_000, 30_000_000, 50_000_000, 92_500_000].find((t) => price > t && land <= t);
    out.push({ code: 'CHATTELS_PRICE', kind: 'contract_term', severity: crosses ? 'warning' : 'info', gate: crosses ? 'exchange' : 'none', page: null, title: `Chattels price ${pounds(c.chattelsPricePennies)}${crosses ? `: takes the land price under £${(crosses / 100).toLocaleString('en-GB')}` : ''}`, detail: `Only the land is charged to SDLT, so the chattels must be valued fairly (second-hand value, not cost); HMRC challenges inflated figures${crosses ? ', especially one that takes the price under a rate threshold' : ''}.${ctx.hasLender ? ' Tell the lender: it lends on the land, not the contents.' : ''}` });
  }
  if (buyer && c.fixturesListPresent === false) out.push({ code: 'NO_FIXTURES_LIST', kind: 'document_missing', severity: 'warning', gate: 'exchange', page: null, title: 'No fittings and contents form (TA10) with the contract', detail: 'Ask for the TA10 to be attached to the contract before exchange, so what stays and what goes is part of the deal.' });
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

// ── The mortgage offer against the case (money.md 5.1, 5.2, 5.5, 5.6) ──
export interface OfferContext { clients: string[]; pricePennies: number | null; declaredAdvancePennies: number | null; previous: MortgageOfferFacts | null; exchanged: boolean }
const sameName = (a: string, b: string) => { const n = (x: string) => x.toLowerCase().replace(/\b(mr|mrs|ms|miss|dr|mx)\b\.?/g, ' ').replace(/[^a-z ]/g, ' ').split(/\s+/).filter(Boolean); const x = n(a), y = n(b); return !!x.length && !!y.length && x[x.length - 1] === y[y.length - 1] && x[0][0] === y[0][0]; };
export function offerFindings(o: MortgageOfferFacts, ctx: OfferContext): Finding[] {
  const out: Finding[] = [];
  const gate: IssueGate = ctx.exchanged ? 'completion' : 'exchange';
  const borrowers = o.borrowerNames ?? [];
  if (borrowers.length && ctx.clients.length) {
    const missing = ctx.clients.filter((c) => !borrowers.some((b) => sameName(b, c)));
    const extra = borrowers.filter((b) => !ctx.clients.some((c) => sameName(b, c)));
    if (missing.length || extra.length) out.push({ code: 'OFFER_BORROWERS', kind: 'lender_approval', severity: 'critical', gate, page: null, title: 'The offer is not made to the buyers', detail: `The offer names ${borrowers.join(' and ')}; the buyers are ${ctx.clients.join(' and ')}.${missing.length ? ` Not on the offer: ${missing.join(', ')}.` : ''}${extra.length ? ` On the offer but not buying: ${extra.join(', ')} (a borrower who is not an owner is not allowed by most lenders).` : ''} Ask the lender for a corrected offer before exchange.` });
  }
  if (o.purchasePricePennies && ctx.pricePennies && Math.abs(o.purchasePricePennies - ctx.pricePennies) >= 100) out.push({ code: 'OFFER_PRICE', kind: 'lender_approval', severity: 'critical', gate, page: null, title: `The offer is on a price of ${pounds(o.purchasePricePennies)}; the price is ${pounds(ctx.pricePennies)}`, detail: 'The lender lent on a different price: tell it the agreed price and get a corrected offer (or its written confirmation the offer stands) before exchange.' });
  if (o.amountPennies && ctx.declaredAdvancePennies && o.amountPennies < ctx.declaredAdvancePennies - 100) out.push({ code: 'OFFER_ADVANCE_SHORT', kind: 'source_of_funds', severity: 'warning', gate, page: null, title: `The advance is ${pounds(ctx.declaredAdvancePennies - o.amountPennies)} less than the client declared`, detail: `The client's proof of funds assumed ${pounds(ctx.declaredAdvancePennies)}; the offer is for ${pounds(o.amountPennies)}. The client must find the difference: a further proof-of-funds round for the extra money.` });
  if (ctx.previous) {
    const was = new Set(ctx.previous.conditions.filter((c) => !c.standard).map((c) => c.text.trim().toLowerCase()));
    const added = o.conditions.filter((c) => !c.standard && !was.has(c.text.trim().toLowerCase()));
    if (added.length) out.push({ code: `OFFER_REISSUED:${added.map((c) => c.code).join(',')}`, kind: 'lender_approval', severity: 'warning', gate, page: null, title: `Re-issued offer: ${added.length} new condition${added.length === 1 ? '' : 's'}`, detail: `New on this offer: ${added.map((c) => `${c.code}: ${c.text.slice(0, 160)}`).join(' | ')}. The new expiry replaces the old one; tell the client what changed.` });
  }
  // A special condition that asks for something before completion: an issue each, cleared by the evidence.
  for (const c of o.conditions.filter((x) => !x.standard && !/retention|retained|withh[eo]ld/i.test(x.text) && /(prior to|before) (completion|the advance|release)|evidence|confirm(ation)?|occupier|undertak|satisf/i.test(x.text))) {
    out.push({ code: `OFFER_CONDITION:${c.code}`, kind: 'mortgage_condition_outstanding', severity: 'warning', gate: 'completion', page: c.locator?.page ?? null, title: `Offer condition ${c.code}: ${c.text.slice(0, 80)}`, detail: `"${c.text.slice(0, 400)}". Get what it asks for and confirm it to the lender before the certificate of title.` });
  }
  return out;
}
