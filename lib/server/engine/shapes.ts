/**
 * Case shapes: the ways a transaction of a given type differs from the plain one, chosen at
 * enrolment. A shape is not a new transaction type (the spine, the sub-flows and the gates
 * are the type's); it adds what the shape needs — an issue that holds the gate it threatens,
 * a source of funds, a policy switch — so the case carries its own checklist from day one.
 */
import type { Side } from './transactions';
import type { IssueGate, IssueKind } from './issues';

export const CASE_SHAPES = ['company_buyer', 'buy_to_let', 'new_build', 'auction', 'lifetime_isa', 'help_to_buy_isa', 'second_charge', 'shared_ownership', 'unrepresented_counterparty', 'court_order_transfer', 'right_to_buy', 'flying_freehold', 'commonhold', 'equity_loan_redemption', 'overseas_entity', 'client_abroad', 'minor_party', 'attorney_benefits', 'deputy', 'trust_client', 'charity', 'vulnerable_client', 'introducer_fee', 'related_party', 'undervalue', 'separating_owners', 'shared_ownership_sale', 'share_of_freehold', 'repossession'] as const;
export type CaseShape = (typeof CASE_SHAPES)[number];

export type FundsRole = 'lender' | 'client' | 'buyer_solicitor' | 'incoming_owner' | 'isa_provider';

export interface ShapeSpec {
  id: CaseShape;
  label: string;
  /** Which sides it applies to. */
  sides: Side[];
  /** What it changes, for the map and the enrolment form. */
  summary: string;
  /** The issue raised at enrolment: the shape's own checklist, holding the gate it threatens until a person resolves it. */
  issue: { kind: IssueKind; title: string; detail: string; gate: IssueGate };
  /** An extra source of completion money. */
  fundsFrom?: FundsRole;
  /** The client's recorded authority to exchange does not apply (the hammer is the exchange). */
  skipExchangeAuthority?: boolean;
  /** A charge the shape always brings to redeem (charges.ts): added to the case's charges at enrolment. */
  charge?: string;
  /** How the ID / AML sub-flow reads under this shape. */
  idCheckLabel?: string;
}

export const SHAPE_SPEC: Record<CaseShape, ShapeSpec> = {
  company_buyer: {
    id: 'company_buyer', label: 'Company Buyer', sides: ['buyer'],
    summary: 'The buyer is a company: Companies House check, identity of every director and person with significant control, authority to buy, and the company\'s source of funds.',
    issue: { kind: 'company_buyer_checks', title: 'Company buyer: Companies House, directors, PSCs, authority and funds', detail: 'Verify the company at Companies House (active, registered office, filing history). Identify every director and person with significant control as for an individual client. Obtain the board minute or resolution authorising the purchase and the signatories. Source of funds is the company\'s: accounts, bank statements, any intercompany or director loan. A lender to a company usually needs a debenture or personal guarantees.', gate: 'exchange' },
    idCheckLabel: 'ID / AML (company, directors and PSCs)',
  },
  buy_to_let: {
    id: 'buy_to_let', label: 'Buy To Let', sides: ['buyer'],
    summary: 'Bought to let: a buy-to-let offer and its rental cover, any sitting tenancy, deposit protection and licensing.',
    issue: { kind: 'buy_to_let_conditions', title: 'Buy to let: offer terms, tenancy, licensing', detail: 'Confirm the offer is a buy-to-let product and its rental-cover and no-owner-occupation conditions. If the property is let: the tenancy agreement, the rent and deposit position (deposit protected, prescribed information served), the right-to-rent checks, and the lender\'s consent to a sitting tenant. Check HMO or selective licensing with the council, and the lease\'s subletting terms on a leasehold. SDLT is at the higher rates.', gate: 'exchange' },
  },
  new_build: {
    id: 'new_build', label: 'New Build', sides: ['buyer'],
    summary: 'Off plan or newly built: the developer\'s pack, warranty, planning and roads agreements, exchange to the developer\'s deadline and completion on notice.',
    issue: { kind: 'new_build_pack', title: 'New build: developer\'s pack, warranty, planning and roads, completion on notice', detail: 'Check the developer\'s contract and transfer: long-stop date, completion on notice after practical completion (usually 10 working days), the deposit and any reservation fee. Obtain the new-home warranty cover note (NHBC, LABC, Premier or similar), planning permission and conditions, building regulations, the section 38 and 104 agreements or bonds for roads and sewers, CIL liability, the plot plan and the estate management scheme. Report the developer\'s exchange deadline to the client and the lender; the lender needs the warranty and will not lend without it.', gate: 'exchange' },
  },
  auction: {
    id: 'auction', label: 'Auction', sides: ['buyer', 'seller'],
    summary: 'Sold at auction: the legal pack is the investigation, the contract binds at the fall of the hammer, and completion follows the conditions of sale (usually 20 working days).',
    issue: { kind: 'auction_conditions', title: 'Auction: legal pack, conditions of sale, deposit and completion deadline', detail: 'Buying: review the legal pack before the auction — special conditions (which often pass the seller\'s costs, arrears and searches to the buyer), the searches in the pack and their age, title, the buyer\'s premium and administration fee, the 10% deposit at the fall of the hammer and the completion deadline in the conditions; there is no chance to raise enquiries afterwards. Selling: assemble the legal pack (title, searches, forms, special conditions) and settle the completion period with the auctioneer. Exchange is the hammer; the client\'s written authority is not a step.', gate: 'exchange' },
    skipExchangeAuthority: true,
  },
  lifetime_isa: {
    id: 'lifetime_isa', label: 'Lifetime ISA', sides: ['buyer'],
    summary: 'Part of the price comes from a Lifetime ISA: the investor declaration, the eligibility limits and the bonus paid to us by the ISA manager.',
    issue: { kind: 'isa_bonus', title: 'Lifetime ISA: declarations and the withdrawal from the ISA manager', detail: 'Eligibility: first-time buyer, price at or below £450,000, a residential mortgage, the account open at least 12 months, completion within 90 days of the withdrawal. The client signs the investor declaration; we send the conveyancer declaration to the ISA manager, who pays the money to our client account within 30 days — request it in time for completion and never before exchange without checking the 90-day window. Two Lifetime ISAs (two buyers) need two withdrawals.', gate: 'completion' },
    fundsFrom: 'isa_provider',
  },
  overseas_entity: {
    id: 'overseas_entity', label: 'Overseas Entity', sides: ['buyer', 'seller'],
    summary: 'A company formed outside the UK buying or selling: its Overseas Entities ID verified, or HM Land Registry will not register.',
    issue: { kind: 'company_buyer_checks', title: 'Overseas entity: Register of Overseas Entities ID, beneficial owners verified', detail: 'An overseas entity must be registered at Companies House with its beneficial owners verified, and give its overseas entity ID: HM Land Registry will not register a purchase without it, and a restriction stops it selling without it. Get the ID before exchange and check it on the register; identify the beneficial owners as clients (LSAG 6.14.11); the entity\'s authority to buy or sell (a board resolution, who signs).', gate: 'exchange' },
  },
  client_abroad: {
    id: 'client_abroad', label: 'Client Abroad', sides: ['buyer', 'seller', 'owner'],
    summary: 'A client living outside the UK: identity checked to a higher standard, documents signed abroad, Stamp Duty residence.',
    issue: { kind: 'aml_kyc_problem', title: 'Client living abroad: higher-standard ID, signing abroad, residence for tax', detail: 'Verify identity remotely to a higher standard (certified documents, an electronic check that covers the country), and apply enhanced due diligence if the country is high-risk (MLR 2017 reg 33). Plan how documents are signed and witnessed abroad (a notary, consular witnessing, an apostille) before exchange. A buyer: the non-resident SDLT surcharge question; a seller: the 60-day CGT report even with no tax to pay.', gate: 'exchange' },
  },
  minor_party: {
    id: 'minor_party', label: 'Client Under 18', sides: ['buyer', 'owner'],
    summary: 'A minor cannot hold a legal estate: adults take the title on trust for them.',
    issue: { kind: 'minor_party', title: 'A client is under 18: they cannot hold the legal estate', detail: 'A transfer to a minor takes effect as a declaration of trust (TLATA 1996 Sch 1 para 1). Restructure: adults (two, ideally) take the legal title and hold on trust for the minor under a declaration of trust, or the purchase waits until they are 18. No lender lends to a minor: tell the lender if one is involved.', gate: 'exchange' },
  },
  attorney_benefits: {
    id: 'attorney_benefits', label: 'Attorney Benefits', sides: ['buyer', 'seller', 'owner'],
    summary: 'The attorney (or their family) is buying from the donor, or the donor is giving or selling under value.',
    issue: { kind: 'power_of_attorney_issue', title: 'The attorney benefits: Court of Protection authority may be needed', detail: 'An attorney must act in the donor\'s best interests and may not benefit or make gifts beyond customary occasions (MCA 2005 s.12). A sale to the attorney or their family, or at an undervalue, needs the Court of Protection\'s authority unless the LPA expressly allows it. Get an independent valuation; escalate to a partner; do not exchange until the authority is on file.', gate: 'exchange' },
  },
  deputy: {
    id: 'deputy', label: 'Court-Appointed Deputy', sides: ['buyer', 'seller', 'owner'],
    summary: 'A client who lacks capacity acts through a deputy: the order checked to cover this transaction.',
    issue: { kind: 'power_of_attorney_issue', title: 'Deputy acting: the Court of Protection order', detail: 'See the sealed order appointing the deputy and check it gives power to sell or buy land (many orders need a specific application for the sale of the client\'s home). Identify the deputy as a client. The deputy signs in the client\'s name; a co-owned trust property also needs a replacement trustee (TDA 1999). Security bond in place.', gate: 'exchange' },
    idCheckLabel: 'ID / AML (the client and the deputy)',
  },
  trust_client: {
    id: 'trust_client', label: 'Trustees', sides: ['buyer', 'seller'],
    summary: 'Trustees buying or selling: the deed, two trustees, the beneficial owners, the Trust Registration Service.',
    issue: { kind: 'trust_client', title: 'Trustees: deed, two trustees, beneficial owners, TRS', detail: 'See the trust deed and confirm the trustees\' power to buy or sell (TLATA 1996 s.6). Two trustees receive capital money on a sale (LPA 1925 s.27). Identify every trustee and the beneficial owners and settlor (LSAG 6.14.16); check the Trust Registration Service entry (MLR 2017 reg 30A).', gate: 'exchange' },
    idCheckLabel: 'ID / AML (every trustee and the beneficial owners)',
  },
  charity: {
    id: 'charity', label: 'Charity', sides: ['buyer', 'seller'],
    summary: 'A charity buying or selling: the Charities Act statements and, on a sale, a surveyor\'s report.',
    issue: { kind: 'charity_terms', title: 'Charity: Charities Act statements and the surveyor\'s report', detail: 'Check the charity on the register and its power to buy or sell. A sale needs a written report from a qualified surveyor and the trustees satisfied the terms are the best reasonably obtainable (Charities Act 2011 ss.117-119), unless to a connected person (then Commission consent). The contract and transfer carry the s.122 statements.', gate: 'exchange' },
  },
  vulnerable_client: {
    id: 'vulnerable_client', label: 'Vulnerable Client', sides: ['buyer', 'seller', 'owner'],
    summary: 'Age, illness, bereavement or language: adjustments recorded, seen alone, instructions their own.',
    issue: { kind: 'vulnerable_client', title: 'Vulnerable client: adjustments and their own instructions', detail: 'Record what makes them vulnerable and the adjustments (how we contact them, plain letters, more time, an interpreter, a trusted person present at their request). See them alone at least once and note that the instructions are their own; watch for someone else driving the transaction (undue influence).', gate: 'exchange' },
  },
  introducer_fee: {
    id: 'introducer_fee', label: 'Paid Introducer', sides: ['buyer', 'seller', 'owner'],
    summary: 'An agent, broker or introducer is paid for the introduction: disclosed to the client in writing.',
    issue: { kind: 'referral_fee', title: 'Introducer paid a fee: disclosed to the client', detail: 'Tell the client in writing, before we act, who introduced them, the fee and who pays it, and that it does not affect our advice (SRA Code 5.1). Record their acknowledgment.', gate: 'exchange' },
  },
  related_party: {
    id: 'related_party', label: 'Related-Party Sale', sides: ['buyer', 'seller'],
    summary: 'Family, employer, landlord to tenant: the lender told, SDLT on the real price, advice for the seller.',
    issue: { kind: 'related_party', title: 'Related-party sale: the lender told, the real price, independent advice', detail: 'A non-arm\'s-length sale: tell the lender (most want to know; any discount given is gifted equity, the deposit). SDLT on what is actually given. Advise the seller to take independent advice where pressure is possible; if we act for both, check a conflict exception applies.', gate: 'exchange' },
  },
  undervalue: {
    id: 'undervalue', label: 'Sale At An Undervalue', sides: ['buyer', 'seller'],
    summary: 'The price is below value: gifted equity, the lender told, the insolvency risk insured.',
    issue: { kind: 'related_party', title: 'Sale at an undervalue: gifted equity, lender, insolvency risk', detail: 'The discount is gifted equity: the lender is told and may treat it as the deposit (a letter from the seller confirming the gift). If the seller is made bankrupt within five years (two for a company) the transaction can be set aside (Insolvency Act 1986 ss.238, 339): advise the buyer and take title insurance. SDLT on the actual price, and the seller\'s CGT at market value if connected.', gate: 'exchange' },
  },
  separating_owners: {
    id: 'separating_owners', label: 'Separating Owners', sides: ['seller', 'owner'],
    summary: 'Owners separating: any order or freezing order checked, both instruct, the proceeds split agreed.',
    issue: { kind: 'joint_client_conflict', title: 'Separating owners: the order, both instructions, the proceeds', detail: 'Ask whether there is a court order (financial remedy, freezing order, or a pending land action registered against the title) and check it permits this sale; the other spouse\'s solicitors consent where it says so. Both owners instruct in writing; agree in writing how the proceeds are paid out before completion (or hold them on an undertaking). If their instructions differ we may not act for both.', gate: 'exchange' },
  },
  shared_ownership_sale: {
    id: 'shared_ownership_sale', label: 'Shared Ownership Sale', sides: ['seller'],
    summary: "Selling a shared-ownership share: the provider's nomination period, its valuation, staircasing first if selling outright.",
    issue: { kind: 'shared_ownership_terms', title: "Shared ownership sale: the provider's nomination period and valuation", detail: "Tell the housing association before marketing: most leases give it a nomination period (often 4 to 8 weeks) to find a buyer at the RICS valuation it instructs (valid 3 months). Only after it ends, or it releases the client, can the share go on the open market. Selling 100%: staircase first, completing the staircasing at the same time as the sale. Get the provider's consent to assign, its fees, and its pack.", gate: 'exchange' },
  },
  share_of_freehold: {
    id: 'share_of_freehold', label: 'Share Of Freehold', sides: ['buyer', 'seller'],
    summary: 'A lease plus a share in the company (or the owners) holding the freehold: both titles, the share transfer, the directorship.',
    issue: { kind: 'lease_defect', title: 'Share of freehold: both titles, the company and the share', detail: 'Read the leasehold title and the freehold title (who holds it: a company, or the owners as trustees). The company: its articles, its accounts, the share certificate and a stock transfer form, the seller resigning as a director and the buyer appointed. The lender\'s share-of-freehold requirements (often a long lease regardless). Check any lease extension the owners granted themselves is registered.', gate: 'exchange' },
  },
  repossession: {
    id: 'repossession', label: 'Repossession Or Probate Sale', sides: ['buyer'],
    summary: 'A lender or personal representatives selling: no TA6 to rely on, a limited title guarantee, sold as seen.',
    issue: { kind: 'disclosure_concern', title: 'Repossession or probate sale: no seller knowledge to rely on', detail: "The seller (a lender selling under its power of sale, LPA 1925 ss.101 and 103, or personal representatives) did not live there: expect no TA6 or a limited one and no title guarantee. Check the power of sale (the charge and the default) or the grant; the mortgagee's transfer overreaches the borrower. Order more searches, take indemnities where needed, and press for a full survey. Advise the client in writing that they have little remedy for anything not disclosed, and check for occupiers.", gate: 'exchange' },
  },
  equity_loan_redemption: {
    id: 'equity_loan_redemption', label: 'Help To Buy Loan To Repay', sides: ['seller', 'owner'],
    summary: 'A Help to Buy equity loan to repay on a sale or remortgage: the RICS valuation, the redemption figure, Homes England\'s consent.',
    charge: 'Homes England (Help to Buy equity loan)',
    issue: { kind: 'third_party_consent', title: 'Help to Buy equity loan: valuation, redemption figure and consent', detail: 'The loan is repaid as a share of the value, not the sum borrowed: the client instructs a RICS valuation (valid three months, and it must still be valid when the redemption is paid), sends it to the scheme administrator, and asks for the redemption figure. Put the figure on the statement before exchange, pay it on completion, and get Homes England\'s release. On a remortgage that keeps the loan, a deed of postponement instead.', gate: 'exchange' },
  },
  second_charge: {
    id: 'second_charge', label: 'Second Charge / Equity Loan', sides: ['buyer'],
    summary: 'A Help to Buy equity loan, shared-equity or other second lender behind the mortgage: both lenders\' consents, the deed of postponement, the second deed.',
    issue: { kind: 'second_charge_consent', title: 'Second charge: consents, postponement and the second deed', detail: 'Report the second loan to the first lender under its instructions and obtain its written consent. The second lender\'s own offer, deed and its consent to the first charge; the deed of postponement executed. A Help to Buy equity loan needs the agency\'s authority to proceed and its solicitor\'s form before completion. Both charges registered in order with the AP1.', gate: 'completion' },
  },
  shared_ownership: {
    id: 'shared_ownership', label: 'Shared Ownership', sides: ['buyer'],
    summary: 'A housing association shared-ownership lease: the share, the rent on the rest, staircasing, the resale nomination, the lender\'s mortgagee protection clause.',
    issue: { kind: 'shared_ownership_terms', title: 'Shared ownership: lease terms, provider approval, rent and staircasing', detail: 'The lease must be the model form with the mortgagee protection clause the lender requires. The provider approves the buyer (eligibility, affordability) and the lender. Advise on the initial share and price, the rent on the unsold share and its review, the service charge, staircasing, the pre-emption / nomination on resale and any restriction on subletting. The lender\'s Part 2 requirements for shared ownership apply.', gate: 'exchange' },
  },
  unrepresented_counterparty: {
    id: 'unrepresented_counterparty', label: 'Unrepresented Other Side', sides: ['buyer', 'seller'],
    summary: 'The other party has no solicitor: no undertakings, identity checked against the title, the lender told, no advice to them.',
    issue: { kind: 'unrepresented_counterparty', title: 'Unrepresented other side: identity, no undertakings, lender told', detail: 'Verify the other party\'s identity and their entitlement against the register (HMLR PG 67 conveyancer\'s confirmation cannot be relied on; use your own checks). Nothing can be done on undertakings: completion money, keys and deeds move only on the day against the executed deed. Tell them in writing that we do not advise them and recommend they instruct a solicitor. Tell the lender.', gate: 'exchange' },
  },
  court_order_transfer: {
    id: 'court_order_transfer', label: 'Transfer Under A Court Order', sides: ['owner'],
    summary: 'A transfer of equity on divorce, dissolution or separation under a court order: the order seen, no consideration, the SDLT exemption, the outgoing owner released by the lender.',
    issue: { kind: 'court_order_transfer', title: 'Court order transfer: the order, the lender\'s release, SDLT exemption', detail: 'A sealed copy of the order (or the consent order / financial remedy order) on file and the transfer drawn to give effect to it. The lender releases the outgoing owner from the mortgage covenant and consents to the transfer; if it will not, a remortgage in the remaining owner\'s name is needed. Transfers in connection with divorce or dissolution are exempt from SDLT (FA 2003 Sch 3 para 3): record sdlt_not_required with that reason. The outgoing owner should have independent advice.', gate: 'completion' },
  },
  right_to_buy: {
    id: 'right_to_buy', label: 'Right To Buy', sides: ['buyer', 'seller'],
    summary: 'Bought from the council or housing association under the Right to Buy: the discount repayment charge for five years and the right of first refusal for ten.',
    issue: { kind: 'right_to_buy_terms', title: 'Right to Buy: discount repayment and the right of first refusal', detail: 'Selling: within five years of the Right to Buy purchase the discount is repaid on a sliding scale (100% in year one, 80% in year two … 20% in year five) as a charge on the title; within ten years the former landlord has the right of first refusal and must be served notice before the property is marketed, and the restriction on the title needs its certificate. Buying: check the charge and the restriction are discharged or complied with, or the price allows for them; some lenders will not lend while a repayment charge subsists.', gate: 'exchange' },
  },
  flying_freehold: {
    id: 'flying_freehold', label: 'Flying Freehold', sides: ['buyer'],
    summary: 'Part of the property lies over or under someone else\'s land: the lender\'s limit, rights of support and access, an indemnity policy.',
    issue: { kind: 'flying_freehold', title: 'Flying freehold: extent, rights of support and access, the lender\'s requirements', detail: 'Establish from the plans how much of the property is flying (a room over a passageway, a cellar under a neighbour). The lender\'s Part 2 usually sets a maximum proportion (often 15–25%) and requires the title to carry mutual rights of support and protection and a right of access to repair; where the title does not, an indemnity policy is the usual answer and the lender must confirm it accepts it.', gate: 'exchange' },
  },
  commonhold: {
    id: 'commonhold', label: 'Commonhold', sides: ['buyer', 'seller'],
    summary: 'A commonhold unit: the commonhold community statement and the association take the place of the lease and the management pack.',
    issue: { kind: 'commonhold_terms', title: 'Commonhold: the community statement, the association and the lender', detail: 'Obtain the commonhold community statement (the rules, the commonhold assessment and reserve fund contributions), the association\'s memorandum, accounts and the unit information certificate (the equivalent of the LPE1). Confirm the lender lends on commonhold before relying on the offer: many do not. There is no ground rent, no forfeiture and no lease term.', gate: 'exchange' },
  },
  help_to_buy_isa: {
    id: 'help_to_buy_isa', label: 'Help To Buy ISA', sides: ['buyer'],
    summary: 'A Help to Buy ISA bonus: the client\'s closing statement, our bonus claim through the scheme portal, and the bonus paid to us before completion.',
    issue: { kind: 'isa_bonus', title: 'Help to Buy ISA: closing statement and the bonus claim', detail: 'Eligibility: first-time buyer, price at or below £250,000 (£450,000 in London), a residential mortgage, the bonus claimed by 1 December 2030. The client closes the ISA and gives us the closing statement; we claim the bonus through the scheme portal and it is paid to our client account, usually within days. The bonus is for completion, not the deposit at exchange. Two ISAs (two buyers) are two claims.', gate: 'completion' },
    fundsFrom: 'isa_provider',
  },
};

export const shapesFor = (side: Side): ShapeSpec[] => CASE_SHAPES.map((s) => SHAPE_SPEC[s]).filter((s) => s.sides.includes(side));
export const shapeLabel = (s: CaseShape): string => SHAPE_SPEC[s]?.label ?? s;
/** The funds roles a case can be paid by: the type's, plus what its shapes add. */
export const fundsFromFor = (base: FundsRole[], shapes: readonly CaseShape[]): FundsRole[] => [...new Set<FundsRole>([...base, ...shapes.map((s) => SHAPE_SPEC[s]?.fundsFrom).filter((r): r is FundsRole => !!r)])];
