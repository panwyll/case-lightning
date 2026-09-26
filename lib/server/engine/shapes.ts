/**
 * Case shapes: the ways a transaction of a given type differs from the plain one, chosen at
 * enrolment. A shape is not a new transaction type (the spine, the sub-flows and the gates
 * are the type's); it adds what the shape needs — an issue that holds the gate it threatens,
 * a source of funds, a policy switch — so the case carries its own checklist from day one.
 */
import type { Side } from './transactions';
import type { IssueGate, IssueKind } from './issues';

export const CASE_SHAPES = ['company_buyer', 'buy_to_let', 'new_build', 'auction', 'lifetime_isa', 'help_to_buy_isa'] as const;
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
