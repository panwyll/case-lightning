/**
 * Fixture facts for the scenario library: what the fixture extractor hands the engine for a
 * sandbox document. Plainly marked as sandbox material; no real person, firm or property.
 */
import type { EnquiryReplyFacts, IdCheckFacts, LeaseFacts, ManagementPackFacts, MortgageOfferFacts, PropertyFormsFacts, SearchFacts, SearchType, TitleFacts } from '../types';
import type { ProofOfFundsSubmission, StatementFacts } from '../proof-of-funds';

export type SearchTypeLike = SearchType;

export const SANDBOX_MARK = 'SANDBOX SCENARIO — not a client document';

/** A plain-text body for a fixture document, so the source pane has something to show. */
export const body = (title: string, lines: string[]): string => [SANDBOX_MARK, '', title.toUpperCase(), '', ...lines, '', 'Every figure here is invented for the scenario library.'].join('\n');

const iso = (d: Date) => d.toISOString().slice(0, 10);
/** Dates relative to today, so a scenario run any day reads as a live case. */
export const exchangeDate = (weeks = 6): string => iso(new Date(Date.now() + weeks * 7 * 86_400_000));
export const completionDate = (weeksAfterExchange = 2): string => iso(new Date(Date.now() + (6 + weeksAfterExchange) * 7 * 86_400_000));

export const idClear = (): IdCheckFacts => ({ provider: 'sandbox-id', outcome: 'clear', flags: [], confidence: 0.99 });
export const idRefer = (): IdCheckFacts => ({ provider: 'sandbox-id', outcome: 'refer', flags: [{ code: 'PEP_MATCH', severity: 'medium', description: 'Possible PEP match on one applicant', locator: { page: 2 } }], confidence: 0.97 });

export const searchClear = (searchType: SearchType): SearchFacts => ({ searchType, flags: [{ code: 'ROAD_ADOPTED', severity: 'info', description: 'Road adopted and maintained at public expense', locator: { page: 3 } }], confidence: 0.96 });
export const searchFlagged = (searchType: SearchType): SearchFacts => ({ searchType, flags: [{ code: 'PLANNING_ENFORCEMENT', severity: 'high', description: 'Enforcement notice registered 2024 re: rear extension', locator: { page: 4, section: '3.7' } }], confidence: 0.93 });

export const replyClear = (enquiryId: string): EnquiryReplyFacts => ({ enquiryId, status: 'answered', issues: [], confidence: 0.95 });
export const replyPartial = (enquiryId: string): EnquiryReplyFacts => ({ enquiryId, status: 'partial', issues: [{ code: 'UNANSWERED', severity: 'medium', description: 'The seller does not know who maintains the fence', locator: { page: 1 } }], confidence: 0.95 });

export const offerClear = (): MortgageOfferFacts => ({ lender: 'Mock Building Society', amountPennies: 25_000_000, expiryDate: iso(new Date(Date.now() + 26 * 7 * 86_400_000)), conditions: [{ code: 'STD1', text: 'Buildings insurance in place on completion', standard: true }], confidence: 0.97 });
export const offerSpecial = (): MortgageOfferFacts => ({ ...offerClear(), conditions: [...offerClear().conditions, { code: 'SC4', text: 'Retention of £5,000 pending roof repairs', standard: false, locator: { page: 6, section: 'Special conditions' } }] });

export const titleClear = (): TitleFacts => ({ titleNumber: 'AB123456', tenure: 'freehold', restrictions: [], charges: [], covenants: [], confidence: 0.98 });
export const titleWithCharge = (): TitleFacts => ({ ...titleClear(), charges: [{ code: 'C1', text: 'Registered charge dated 12 May 2019 in favour of Big Bank plc', register: 'C', locator: { page: 2, section: 'C: Charges register' } }] });

export const leaseShort = (): LeaseFacts => ({ unexpiredYears: 78, groundRentPenniesPa: 35_000, groundRentReview: 'doubling every 10 years', locator: { page: 3 } });
export const lease = (flagged: boolean): LeaseFacts => ({
  demise: 'Flat 3, second floor, with the balcony', landlord: 'Sandbox Freeholds Limited', termYears: 125, termStartDate: '1998-01-01', leaseDate: '1998-03-14', unexpiredYears: flagged ? 78 : 96,
  groundRentPenniesPa: flagged ? 35_000 : 25_000, groundRentReview: flagged ? 'The rent doubles on every 10th anniversary of the term' : 'Fixed for the term',
  serviceChargeProportion: '12.5%', repairs: 'The lessor repairs the structure and roof; the lessee repairs the interior and windows', alienation: 'Not to assign without the prior written consent of the lessor, not to be unreasonably withheld',
  alterations: 'No structural alterations', permittedUse: 'A single private dwelling', insurance: 'The lessor insures; the lessee pays a fair proportion of the premium', landlordNotices: 'Notice of assignment and of any charge within one month, fee £75 plus VAT', forfeiture: 'Re-entry on 21 days\' arrears or breach of covenant',
  clauses: [{ code: '3.1', topic: 'rent', text: flagged ? 'The rent doubles on every 10th anniversary of the term' : 'The rent is £250 a year for the term', locator: { page: 2 } }], flags: [], confidence: 0.93,
});

export const managementPack = (flagged: boolean): ManagementPackFacts => ({
  landlord: 'Sandbox Freeholds Limited', managingAgent: 'Block Managers Ltd', serviceChargePenniesPa: 240_000, serviceChargePeriod: '1 April 2026 to 31 March 2027', serviceChargeProportion: '12.5%', groundRentPenniesPa: flagged ? 35_000 : 25_000,
  arrearsPennies: 0, reserveFundPennies: 1_200_000, majorWorksPlanned: flagged, majorWorks: flagged ? 'Roof renewal 2027, estimated £48,000, this flat 12.5%' : null, section20Notice: flagged, buildingsInsuranceInPlace: true, insurer: 'Aviva', insuredSumPennies: 320_000_000, insuranceExpiryDate: '2027-02-28',
  fees: { noticeOfAssignmentPennies: 9_000, noticeOfChargePennies: 9_000, deedOfCovenantPennies: 15_000, certificateOfCompliancePennies: null, other: null }, consentsRequired: 'Deed of covenant with the management company', disputes: null, accountsProvided: 'Years ending March 2024 and 2025; budget 2026/27',
  entries: [], flags: flagged ? [{ code: 'MAJOR_WORKS_PLANNED', severity: 'medium', description: 'Roof renewal planned for 2027 at an estimated £48,000', locator: { page: 2 } }] : [], confidence: 0.9,
});

/** The seller's TA6 (and TA7 on a leasehold): clean answers, or works without consent and knotweed on the flagged run. */
export const propertyForms = (flagged: boolean, leasehold = false): PropertyFormsFacts => ({
  forms: leasehold ? ['TA6', 'TA7', 'TA10'] : ['TA6', 'TA10'],
  disclosures: [],
  confidence: 0.94,
  answers: {
    disputes: null, notices: null,
    alterations: flagged ? 'Rear single-storey extension 2019; replacement windows 2021' : null,
    alterationsConsented: flagged ? false : null, alterationsDocumentsEnclosed: flagged ? false : null, listedOrConservation: false,
    guaranteesOutstandingClaims: null, insuranceClaims: null, insuranceRefused: false,
    flooded: false, floodDetail: null, japaneseKnotweed: flagged, knotweedDetail: flagged ? 'Treated 2023 under a five-year plan with an insurance-backed guarantee' : null, radonTestAboveAction: false,
    occupiers: null, sharedAccessOrServices: false, rightsOfWayOverProperty: null, septicTank: false, solarPanelsLeased: false, boundariesUnclear: null,
    leaseholdArrearsOrDispute: false, epcRating: 'C', councilTaxBand: 'D',
  },
  pages: { alterations: 3, environment: 5 },
});

/** The client's proof-of-funds declaration: savings that cover the balance; the flagged run adds a gift from a donor abroad. */
export const pofSubmission = (pricePennies: number, advancePennies: number | null, flagged: boolean, statementDocId: string, donorStatementDocId: string | null, giftLetterDocId: string | null): ProofOfFundsSubmission => {
  const balance = pricePennies - (advancePennies ?? 0);
  const giftPennies = flagged ? 4_000_000 : 0;
  return {
    declarant: { fullName: 'Sandbox Buyer', email: 'sandbox.buyer@example.invalid', phone: null },
    purchasePricePennies: pricePennies,
    mortgageAdvancePennies: advancePennies,
    sources: [
      { kind: 'savings', amountPennies: balance - giftPennies, description: 'Saved from salary, Sandbox Savings Bank', bankName: 'Sandbox Savings Bank', accountHolder: 'Sandbox Buyer', evidenceDocumentIds: [statementDocId] },
      ...(flagged ? [{ kind: 'gift' as const, amountPennies: giftPennies, description: 'Gift from my mother', evidenceDocumentIds: giftLetterDocId ? [giftLetterDocId] : [], gift: { donorName: 'Sandbox Donor', donorRelationship: 'mother', donorAddress: 'Barcelona', repayable: false, donorAbroad: true, jointDonorName: 'Sandbox Donor Two', donorEvidenceDocumentIds: donorStatementDocId ? [donorStatementDocId] : [] } }] : []),
    ],
    declarations: { accurate: true, noThirdPartyInterest: true, noUndisclosedBorrowing: true },
    clientNote: null,
    submittedAt: new Date().toISOString(),
  };
};

/** A bank statement the fixture extractor reads: three months of salary in, a balance that covers what it is meant to prove. */
export const statement = (holder: string, closingPennies: number, employer = 'Sandbox Employer Ltd'): StatementFacts => {
  // A holder line naming two people reads as a joint account, as a real statement prints it.
  const end = new Date(); end.setUTCDate(1);
  const days = (n: number) => iso(new Date(end.getTime() - n * 86_400_000));
  const salary = 320_000;
  const transactions = [0, 30, 60].flatMap((d) => [
    { date: days(d + 2), description: `${employer.toUpperCase()} SALARY`, amountPennies: salary, counterparty: employer },
    { date: days(d + 9), description: 'COUNCIL TAX', amountPennies: -18_000, counterparty: 'Sampletown Council' },
    { date: days(d + 14), description: 'SUPERMARKET', amountPennies: -12_500, counterparty: null },
    { date: days(d + 20), description: 'TRANSFER TO SAVINGS', amountPennies: -150_000, counterparty: holder },
  ]);
  return {
    accountHolder: holder, bankName: 'Sandbox Savings Bank', accountLast4: '1234', periodFrom: days(92), periodTo: days(0),
    openingBalancePennies: closingPennies - 3 * (salary - 18_000 - 12_500 - 150_000), closingBalancePennies: closingPennies,
    transactions, salaryCredits: [0, 30, 60].map((d) => ({ date: days(d + 2), amountPennies: salary, payer: employer })), confidence: 0.95,
  };
};
