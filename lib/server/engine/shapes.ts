/**
 * Case shapes: the ways a transaction of a given type differs from the plain one, chosen at
 * enrolment. A shape is not a new transaction type (the spine, the sub-flows and the gates
 * are the type's); it adds what the shape needs — an issue that holds the gate it threatens,
 * a source of funds, a policy switch — so the case carries its own checklist from day one.
 */
import type { Side } from './transactions';
import type { IssueGate, IssueKind } from './issues';

export const CASE_SHAPES = ['company_buyer', 'buy_to_let', 'new_build', 'auction', 'lifetime_isa', 'help_to_buy_isa', 'second_charge', 'shared_ownership', 'unrepresented_counterparty', 'court_order_transfer', 'right_to_buy', 'flying_freehold', 'commonhold', 'equity_loan_redemption'] as const;
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
