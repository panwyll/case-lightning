/**
 * Component #2 — document ingestion + extraction pipeline.
 *
 *   raw PDF / scan / image / text
 *     → classify (what is this? which sub-flow does it belong to?)
 *     → extract (typed facts with a per-field confidence and a page/quote locator)
 *     → normalise (deterministic: codes, severities, confidence floor)
 *     → persist on document.extracted_facts (+ extraction_confidence)
 *     → hand to the engine (service.ts), whose RULE layer decides clear vs flag
 *
 * Design rules:
 *   - Confidence is a first-class output. The overall confidence is the MINIMUM of the
 *     model's document-level confidence and every flag's own confidence, so one shaky
 *     field drags the whole extraction under the threshold and to a human.
 *   - Every flag carries a locator (page + quote). The decision the handler sees cites
 *     it; the rubber-stamp guard depends on it.
 *   - Variable-quality scans are the norm: the model is told to lower confidence on
 *     illegible pages rather than fill gaps, and a failed call becomes confidence 0.
 *   - The model never decides severity policy alone: severities it proposes are
 *     clamped by a code→minimum-severity table so a known-serious code can't be
 *     downgraded to "info" by a lenient read.
 */
import crypto from 'node:crypto';
import { z } from 'zod/v4';
import type { ContractFacts, EnquiryReplyFacts, Flag, IdCheckFacts, MortgageOfferFacts, SearchFacts, SearchType, Severity, TitleFacts, TitlePlanFacts, SupportingDocFacts, SurveyFacts, LeaseFacts, ManagementPackFacts } from './types';
import { type PropertyFormsFacts, SEARCH_TYPES } from './types';
import type { DocumentExtractor, DocumentRef } from './ports';
import { ENGINE_SYSTEM_GUARD, EngineLlmError, leanDocument, type EngineDocumentInput, type StructuredLlm } from './llm';
import { mergeReadings, pdfSections, shiftPages, type PdfSection } from './sections';

/** Documents where a misread costs the client: read as the PDF itself, on the strongest model. */
const CRITICAL_ROLES = new Set(['title', 'contract', 'lease']);
import { MIN_EXTRACTION_CONFIDENCE } from './rules';
import { PageLedgerSchema, buildReview, pageTextsWithOcr, type DocumentReview, type PageTexts } from './review';
import type { StatementFacts, PayslipFacts, EvidenceKind } from './proof-of-funds';

// ───────────────────────────── schemas (what the model must return) ─────────────────────────────

const conf = z.number().min(0).max(1).describe('0–1 confidence that this value is exactly right. Lower it for illegible scans, partial pages or inference.');
const locator = z.object({
  page: z.number().int().min(1).describe('1-based page number the fact appears on.'),
  section: z.string().describe('Section / question / register heading, e.g. "3.7", "C: Charges register", "Special condition 4". Empty string if none.'),
  quote: z.string().describe('Short verbatim quote (≤ 200 chars) of the text relied on.'),
});
const severity = z.enum(['info', 'low', 'medium', 'high']);

const flagSchema = z.object({
  code: z.string().describe('UPPER_SNAKE_CASE code from the taxonomy in the instructions, or a new one in the same style.'),
  severity,
  description: z.string().describe('One plain-English sentence stating the finding as a fact (no advice).'),
  locator,
  confidence: conf,
});

export const ClassificationSchema = z.object({
  role: z.enum(['search', 'enquiry_reply', 'mortgage_offer', 'title', 'title_plan', 'supporting_document', 'id_check', 'contract', 'survey', 'specialist_report', 'management_pack', 'lease', 'property_forms', 'hmlr_requisition', 'other']),
  searchType: z.enum([...SEARCH_TYPES, 'NONE']).describe('Only when role = search.'),
  enquiryReferences: z.array(z.string()).describe('Enquiry numbers/identifiers the document replies to (e.g. "E1", "3", "Additional enquiry 2"), when role = enquiry_reply.'),
  titleNumber: z.string().describe('Land Registry title number if visible, else empty string.'),
  lender: z.string().describe('Lender name if this is a mortgage offer, else empty string.'),
  scanQuality: z.enum(['good', 'fair', 'poor', 'unreadable']),
  pageCount: z.number().int().min(0),
  confidence: conf,
  reason: z.string().describe('One sentence: what in the document tells you this.'),
});
export type Classification = z.infer<typeof ClassificationSchema>;

export const SearchExtractionSchema = z.object({
  searchType: z.enum(SEARCH_TYPES),
  provider: z.string(),
  searchDate: z.string().describe('ISO date the search was compiled, or empty string.'),
  propertyAddressAsSearched: z.string(),
  flags: z.array(flagSchema).describe('Every adverse or notable entry. Use severity "info" for routine entries (adopted road, no entries) so the handler sees they were checked.'),
  pages: PageLedgerSchema,
  summaryFields: z.array(z.object({ label: z.string(), value: z.string(), locator })).describe('Headline facts a conveyancer expects (e.g. planning history count, road status, drainage connection).'),
  scanQuality: z.enum(['good', 'fair', 'poor', 'unreadable']),
  confidence: conf.describe('Document-level confidence that nothing material was missed.'),
});

export const EnquiryReplyExtractionSchema = z.object({
  pages: PageLedgerSchema,
  replies: z.array(
    z.object({
      enquiryReference: z.string().describe('The enquiry number/identifier as written in the reply.'),
      status: z.enum(['answered', 'partial', 'refused', 'unclear']),
      replyText: z.string().describe('Verbatim reply (≤ 600 chars).'),
      issues: z.array(flagSchema),
      locator,
      confidence: conf,
    })
  ),
  scanQuality: z.enum(['good', 'fair', 'poor', 'unreadable']),
  confidence: conf,
});

export const MortgageOfferExtractionSchema = z.object({
  pages: PageLedgerSchema,
  lender: z.string(),
  borrowerNames: z.array(z.string()),
  propertyAddress: z.string(),
  purchasePricePennies: z.number().int().min(0).describe('The purchase price the offer is based on, in pennies; 0 if not stated.').optional(),
  amountPennies: z.number().int().min(0).describe('Loan amount in pennies; 0 if not stated.'),
  expiryDate: z.string().describe('ISO date the offer expires, or empty string.'),
  conditions: z.array(
    z.object({
      code: z.string().describe('The offer\'s own condition reference, e.g. "SC4" or "General condition 12".'),
      text: z.string().describe('Verbatim condition (≤ 500 chars).'),
      standard: z.boolean().describe('true ONLY for the lender\'s boilerplate general conditions; false for any special/specific condition, retention, occupier consent, or evidence request.'),
      locator,
      confidence: conf,
    })
  ),
  scanQuality: z.enum(['good', 'fair', 'poor', 'unreadable']),
  confidence: conf,
});

const titleEntry = z.object({
  code: z.string().describe('Entry number as printed, e.g. "B2", "C1".'),
  text: z.string().describe('Verbatim entry (≤ 600 chars).'),
  register: z.enum(['A', 'B', 'C']),
  locator,
  confidence: conf,
});
export const SupportingDocSchema = z.object({
  pages: PageLedgerSchema,
  kind: z.enum(['indemnity_policy', 'planning_permission', 'building_regs', 'guarantee', 'certificate', 'other']),
  title: z.string(),
  covers: z.string(),
  issuedBy: z.string(),
  reference: z.string(),
  date: z.string().describe('ISO date or empty'),
  expires: z.string().describe('ISO date or empty'),
  limitPennies: z.number().int().nullable().describe('Indemnity policies: the limit in pennies, or null'),
  benefitPasses: z.boolean().nullable().describe('Indemnity policies: does the cover pass to the buyer, successors and mortgagee? null if not stated'),
  property: z.string(),
  notes: z.array(z.string()),
  confidence: z.number(),
});

export const TitlePlanSchema = z.object({
  pages: PageLedgerSchema,
  titleNumber: z.string(),
  edgedRed: z.string().describe('What the red edging encloses, as drawn.'),
  otherMarkings: z.array(z.object({ marking: z.string().describe('The colour, hatching or number, e.g. "tinted brown", "edged green", "1"'), marks: z.string().describe("What the plan or its key says it marks, or 'not stated on the plan'") })),
  notes: z.array(z.string()),
  reference: z.string().describe('Date, scale or OS reference as printed, or empty'),
  confidence: z.number(),
});

export const TitleExtractionSchema = z.object({
  pages: PageLedgerSchema,
  titleNumber: z.string(),
  tenure: z.enum(['freehold', 'leasehold', 'unknown']),
  planOnly: z.boolean().describe('True if this document is only a title plan (a map with a title number and edging) with no register entries at all; then leave the register fields empty.'),
  unregistered: z.boolean().describe('True if the document is an epitome of title / abstract / deeds bundle for UNREGISTERED land rather than an official copy of a registered title.'),
  editionDate: z.string().describe('Edition/official copy date, ISO or empty.'),
  registeredProprietors: z.array(z.string()),
  titleClass: z.enum(['absolute', 'possessory', 'qualified', 'good_leasehold', 'unknown']).describe('The class of title from the proprietorship register heading ("Title absolute", "Possessory title"...).'),
  proprietorAddresses: z.array(z.string()).describe('The address(es) for service given for the proprietors in the B register, as printed.'),
  proprietorSince: z.string().describe('ISO date the current proprietor was registered (the B register entry date), or empty.'),
  pricePaidPennies: z.number().int().describe('The price paid stated in the B register, in pennies; 0 if none.'),
  notices: z.array(titleEntry).describe('Notices in the charges register (agreed or unilateral notices, home rights, leases noted), each as its own entry.'),
  propertyDescription: z.string(),
  restrictions: z.array(titleEntry),
  charges: z.array(titleEntry),
  covenants: z.array(titleEntry).describe('Restrictive or positive covenants, easements and rights that bind or benefit the land.'),
  propertyEntries: z.array(titleEntry).optional().describe('The property (A) register entries: rights granted or reserved, mines and minerals excepted, rentcharges, manorial rights.'),
  pendingApplications: z.array(z.string()).optional().describe('Applications pending at HM Land Registry, as listed at the top of the official copy; empty if none.'),
  scanQuality: z.enum(['good', 'fair', 'poor', 'unreadable']),
  confidence: conf,
});

/** Proof of funds: a bank statement read line by line. The full account number is never extracted. */
export const StatementExtractionSchema = z.object({
  isBankStatement: z.boolean().describe('false if the document is not a bank / building society / e-money account statement (e.g. a gift letter, an ID, a payslip).'),
  documentKind: z.enum(['bank_statement', 'payslip', 'gift_letter', 'id_document', 'sale_memorandum', 'other']).describe('What the document is.'),
  payslip: z.object({ employeeName: z.string().nullable(), employer: z.string().nullable(), payDate: z.string().nullable().describe('ISO date'), netPayPennies: z.number().int().nullable(), grossPayPennies: z.number().int().nullable() }).nullable().describe('Filled in when the document is a payslip; null otherwise.'),
  accountHolder: z.string().nullable().describe('The account holder\'s name as printed.'),
  bankName: z.string().nullable(),
  accountLast4: z.string().nullable().describe('Last four digits of the account number only.'),
  periodFrom: z.string().nullable().describe('ISO date of the first day covered.'),
  periodTo: z.string().nullable().describe('ISO date of the last day covered.'),
  openingBalancePennies: z.number().int().nullable(),
  closingBalancePennies: z.number().int().nullable(),
  transactions: z.array(z.object({ date: z.string().describe('ISO date'), description: z.string().describe('The line as printed, including any reference'), amountPennies: z.number().int().describe('Signed pennies: credits positive, debits negative'), balancePennies: z.number().int().nullable(), counterparty: z.string().nullable().describe('The payer / payee name if the line shows one') })).describe('EVERY transaction in the period, in order. Do not summarise or skip lines.'),
  salaryCredits: z.array(z.object({ date: z.string(), amountPennies: z.number().int(), payer: z.string() })).describe('Credits that are clearly salary / wages / regular income (the employer as printed).'),
  scanQuality: z.enum(['good', 'fair', 'poor', 'unreadable']),
  confidence: conf,
});

export const SurveyExtractionSchema = z.object({
  surveyType: z.enum(['level1', 'level2', 'level3', 'valuation', 'specialist']),
  surveyor: z.string().nullable(),
  summary: z.string().nullable().describe('The report\'s own overall summary in one or two sentences, if it gives one.'),
  recommendations: z.array(z.object({ code: z.string().describe('Short stable code, e.g. DAMP_REAR, ROOF_COVERING, ELECTRICS'), text: z.string(), furtherInvestigation: z.boolean(), specialist: z.string().nullable(), severity: z.enum(['info', 'low', 'medium', 'high']), rating: z.number().int().min(1).max(3).nullable().describe('The RICS condition rating the report gives this element (3, 2 or 1), or null when it gives none.'), page: z.number().int().nullable() })),
  legalIssues: z.array(z.object({ category: z.enum(['regulation', 'guarantee', 'other']), text: z.string().describe('The point as the surveyor puts it, e.g. "Obtain building regulations completion certificate for the rear extension".'), page: z.number().int().nullable() })).describe('Every point in the section for the legal adviser ("Issues for your legal advisers": Regulation, Guarantees, Other matters), and any other place the surveyor asks the solicitor or conveyancer to check or obtain something. Empty when there is none.'),
  risks: z.array(z.string()).describe('The "Risks" section: risks to the building, the grounds and people, one line each. Empty when none.'),
  marketValuePennies: z.number().int().nullable().describe('The surveyor\'s opinion of market value in pennies, or null.'),
  reinstatementCostPennies: z.number().int().nullable().describe('The reinstatement cost for insurance in pennies, or null.'),
  scanQuality: z.enum(['good', 'fair', 'poor', 'unreadable']),
  confidence: conf,
});

export const ContractExtractionSchema = z.object({
  pages: PageLedgerSchema,
  sellers: z.array(z.string()).describe('Every seller as named in the contract.'),
  buyers: z.array(z.string()).describe('Every buyer as named in the contract.'),
  propertyAddress: z.string(),
  titleNumber: z.string().describe('Title number as printed, or empty string.'),
  pricePennies: z.number().int().min(0).describe('Purchase price in pennies; 0 if not stated.'),
  depositPennies: z.number().int().min(0).describe('Deposit in pennies; 0 if not stated.'),
  depositHolder: z.string().describe('Who holds the deposit and on what terms (stakeholder / agent), or empty string.'),
  completionDate: z.string().describe('ISO completion date if fixed, else empty string.'),
  chattelsPricePennies: z.number().int().min(0).describe('Chattels / contents price in pennies; 0 if none.'),
  vat: z.string().describe('What the contract says about VAT, or empty string.'),
  incorporatedConditions: z.string().describe('The standard conditions incorporated (e.g. "Standard Conditions of Sale (5th edition, 2018 revision)"), or empty string.'),
  noticeToCompleteDays: z.number().int().min(0).describe('Working days a notice to complete gives; 0 if not stated.'),
  fixturesListPresent: z.boolean(),
  specialConditions: z.array(z.object({ code: z.string().describe('The condition\'s own number, e.g. "SC 5".'), text: z.string().describe('Verbatim (≤ 600 chars).'), locator, confidence: conf })),
  indemnities: z.array(z.object({ text: z.string().describe('Verbatim indemnity or indemnity-insurance term (≤ 400 chars).'), locator, confidence: conf })),
  flags: z.array(flagSchema).describe('Anything a conveyancer must decide on: a non-standard special condition, an unusual deposit, a completion date fixed already, a retention, a conditional contract, VAT, missing fixtures list.'),
  signedBy: z.array(z.string()).describe('Everyone whose signature actually appears on the contract (handwritten, or an electronic signature block), by the name printed with it. Empty if the contract is unsigned. Never infer a signature from a typed name in the parties clause.'),
  dated: z.boolean().describe('True only if the contract date has been filled in.'),
  scanQuality: z.enum(['good', 'fair', 'poor', 'unreadable']),
  confidence: conf,
});

const money = (what: string) => z.number().int().min(0).describe(`${what} in pennies; 0 if not stated.`);
const text = (what: string) => z.string().describe(`${what}, verbatim or closely paraphrased (≤ 400 chars); empty string if the document is silent.`);

/** The lease read for its terms: what the review table shows and the rules test. */
export const LeaseExtractionSchema = z.object({
  pages: PageLedgerSchema,
  demise: text('The demised premises as described (flat, floor, included parts such as a balcony, store or parking space)'),
  landlord: z.string().describe('The lessor / landlord as named; empty string if not stated.'),
  managementCompany: z.string().describe('Any management company party to the lease; empty string if none.'),
  termYears: z.number().int().min(0).describe('The term in years; 0 if not stated.'),
  termStartDate: z.string().describe('ISO date the term runs from; empty string if not stated.'),
  leaseDate: z.string().describe('ISO date of the lease; empty string if not stated.'),
  unexpiredYears: z.number().int().min(0).describe('Years left today, computed from the term start and length; 0 if it cannot be computed.'),
  groundRentPenniesPa: money('Ground rent a year now'),
  groundRentReview: text('The ground rent review clause: when and how the rent changes (doubling, RPI, fixed steps)'),
  serviceChargeProportion: text('The service charge proportion or apportionment the lessee pays'),
  repairs: text('Who repairs and maintains what: structure, roof, foundations, windows, the interior of the flat, common parts'),
  alienation: text('Assignment, underletting and sharing: whether consent is required, absolute or qualified, and any conditions such as a deed of covenant or notice'),
  alterations: text('Alterations: what is prohibited and what needs consent'),
  permittedUse: text('The permitted use and any restrictions (single private dwelling, no business, pets)'),
  insurance: text('Who insures the building and who pays the premium'),
  landlordNotices: text('Notices of assignment / charge, registration and deed of covenant requirements and the fees the lease fixes'),
  forfeiture: text('The forfeiture / re-entry clause in short'),
  clauses: z.array(z.object({ code: z.string().describe('The clause number as printed, e.g. "3.14" or "Schedule 5 para 2".'), topic: z.enum(['term', 'rent', 'service_charge', 'repairs', 'alienation', 'alterations', 'use', 'insurance', 'notices', 'forfeiture', 'other']), text: z.string().describe('Verbatim (≤ 600 chars).'), locator, confidence: conf })).describe('Every clause relied on for the fields above, verbatim with its page.'),
  flags: z.array(flagSchema).describe('Anything a conveyancer must decide on: a short term, an escalating rent, an onerous covenant, an absolute bar on assignment, a use restriction that bites, a forfeiture on bankruptcy, a rent that turns the lease into an assured tenancy.'),
  scanQuality: z.enum(['good', 'fair', 'poor', 'unreadable']),
  confidence: conf,
});

/** The LPE1 / management pack read for its answers: what the review table shows and the decision summarises. */
export const ManagementPackExtractionSchema = z.object({
  pages: PageLedgerSchema,
  landlord: z.string().describe('The landlord / freeholder as named; empty string if not stated.'),
  managingAgent: z.string().describe('The managing agent as named; empty string if none.'),
  serviceChargePenniesPa: money('Current service charge a year for this flat'),
  serviceChargePeriod: z.string().describe('The service charge year the figure covers, as written; empty string if not stated.'),
  serviceChargeProportion: z.string().describe('The proportion this flat pays, as written; empty string if not stated.'),
  groundRentPenniesPa: money('Ground rent a year'),
  arrearsPennies: money('Service charge or ground rent arrears on the account'),
  reserveFundPennies: money('The reserve / sinking fund balance'),
  majorWorksPlanned: z.boolean().describe('True if any major works are planned, consulted on or levied.'),
  majorWorks: text('The major works: what, when, the estimated cost and this flat\'s share'),
  section20Notice: z.boolean().describe('True if a section 20 consultation has started or is in progress.'),
  buildingsInsuranceInPlace: z.boolean(),
  insurer: z.string().describe('The buildings insurer; empty string if not stated.'),
  insuredSumPennies: money('The sum insured for the building'),
  insuranceExpiryDate: z.string().describe('ISO expiry / renewal date of the buildings insurance; empty string if not stated.'),
  feeNoticeOfAssignmentPennies: money('Fee for registering a notice of assignment, as stated: the figure before VAT when it is quoted "plus VAT" (never add the VAT yourself)'),
  feeNoticeOfChargePennies: money('Fee for registering a notice of charge, as stated: before VAT when quoted "plus VAT"'),
  feeDeedOfCovenantPennies: money('Fee for a deed of covenant, as stated: before VAT when quoted "plus VAT"'),
  feeCertificateOfCompliancePennies: money('Fee for a certificate of compliance (Land Registry restriction), as stated: before VAT when quoted "plus VAT"'),
  feesOther: text('Any other fees the buyer must pay the landlord or agent on sale; say whether the fees above are plus VAT'),
  consentsRequired: text('Consents the landlord requires on sale: licence to assign, deed of covenant, share transfer, references'),
  disputes: text('Disputes, litigation, breaches of covenant, forfeiture proceedings or complaints disclosed'),
  bsaRelevantBuilding: z.enum(['yes', 'no', 'not_stated']).describe('Building Safety Act: is the building a "relevant building" (at least 11 m or 5 storeys, two or more dwellings)?'),
  bsaLeaseholderDeedOfCertificate: z.enum(['yes', 'no', 'not_stated']).describe('Has a leaseholder deed of certificate been given / is one enclosed?'),
  bsaLandlordCertificate: z.enum(['yes', 'no', 'not_stated']).describe('Has the landlord\'s certificate been given / is one enclosed?'),
  bsaRemediation: text('External wall / cladding / fire safety position: EWS1, remediation works, funding, any Building Safety Fund or developer pledge, as stated'),
  accountsProvided: z.string().describe('Which years\' accounts and budgets are enclosed, as written; empty string if none.'),
  entries: z.array(z.object({ code: z.string().describe('The LPE1 question number, e.g. "3.4", or the enclosure name.'), text: z.string().describe('The answer verbatim (≤ 600 chars).'), locator, confidence: conf })).describe('Every answer relied on for the fields above, verbatim with its page.'),
  flags: z.array(flagSchema).describe('Anything a conveyancer must decide on: arrears, major works or a section 20 notice, no or inadequate insurance, a reserve fund not held, a dispute, high fees, a consent that may be refused, accounts missing.'),
  scanQuality: z.enum(['good', 'fair', 'poor', 'unreadable']),
  confidence: conf,
});

/** The seller's property information forms (TA6; TA7 on a leasehold; TA10 fittings) read answer by answer. */
export const PropertyFormsExtractionSchema = z.object({
  pages: PageLedgerSchema,
  forms: z.array(z.enum(['TA6', 'TA7', 'TA10', 'TA13', 'OTHER'])).describe('Which forms the document contains.'),
  disputes: text('TA6 section 2: any dispute, complaint or notice with a neighbour or anyone else, as answered'),
  notices: text('TA6 section 3: notices, planning proposals or letters affecting the property or a neighbour, as answered'),
  alterations: text('TA6 section 4: building works, extensions, conversions, replacement windows or doors, as listed'),
  alterationsConsented: z.enum(['yes', 'no', 'not_stated']).describe('Does the seller say every planning permission and building regulations approval was obtained for the works listed?'),
  alterationsDocumentsEnclosed: z.enum(['yes', 'no', 'not_stated']).describe('Are the consents, completion certificates or FENSA / Gas Safe certificates enclosed?'),
  listedOrConservation: z.enum(['yes', 'no', 'not_stated']).describe('Listed building or conservation area.'),
  guaranteesOutstandingClaims: text('TA6 section 5: any outstanding claim or refused claim under a guarantee or warranty'),
  insuranceClaims: text('TA6 section 6: buildings insurance claims made'),
  insuranceRefused: z.enum(['yes', 'no', 'not_stated']).describe('Insurance refused, or on special terms, or with an abnormally high premium.'),
  flooded: z.enum(['yes', 'no', 'not_stated']).describe('TA6 section 7: has the property or its land flooded?'),
  floodDetail: text('When and what flooded, as answered'),
  japaneseKnotweed: z.enum(['yes', 'no', 'not_known', 'not_stated']).describe('TA6 section 7: is the property affected by Japanese knotweed?'),
  knotweedDetail: text('The management plan or treatment, as answered'),
  radonTestAboveAction: z.enum(['yes', 'no', 'not_stated']).describe('A radon test at or above the action level, or remedial works.'),
  occupiers: text('TA6 section 11: adults other than the seller living at the property, as named or described'),
  sharedAccessOrServices: z.enum(['yes', 'no', 'not_stated']).describe('TA6 sections 8-9: shared drives, paths, pipes or services.'),
  rightsOfWayOverProperty: text('Rights others have over the property (access, services, light), as answered'),
  septicTank: z.enum(['yes', 'no', 'not_stated']).describe('Foul drainage to a septic tank or treatment plant rather than the mains.'),
  solarPanelsLeased: z.enum(['yes', 'no', 'not_stated']).describe('Solar panels owned by a third party or the roof let under a lease.'),
  boundariesUnclear: text('TA6 section 1: boundary features the seller is unsure of, or that have moved'),
  leaseholdArrearsOrDispute: z.enum(['yes', 'no', 'not_stated']).describe('TA7: service charge / ground rent arrears or a dispute with the landlord or managing agent.'),
  epcRating: z.string().describe('EPC rating letter if stated; empty string if not.'),
  councilTaxBand: z.string().describe('Council tax band if stated; empty string if not.'),
  alterationsYear: z.string().describe('The year the works in the alterations answer were done (YYYY), or empty.').optional(),
  windowsReplacedSince2002: z.enum(['yes', 'no', 'not_stated']).describe('Windows, roof windows or glazed doors replaced since April 2002 (TA6 section 4).').optional(),
  windowsCertificate: z.enum(['yes', 'no', 'not_stated']).describe('A FENSA / CERTASS certificate or building regulations approval for the replacement windows is said to exist.').optional(),
  electricalWorkSince2005: z.enum(['yes', 'no', 'not_stated']).describe('Electrical work done since January 2005 (TA6 section 4/9).').optional(),
  electricalCertificate: z.enum(['yes', 'no', 'not_stated']).describe('A Part P / NICEIC / building regulations certificate for the electrical work is said to exist.').optional(),
  gasApplianceNoRecord: z.enum(['yes', 'no', 'not_stated']).describe('A gas boiler or appliance was installed with no Gas Safe record or certificate.').optional(),
  knotweedCategory: z.string().describe('A Japanese knotweed category (A, B, C or D) if a survey or the form states one; empty if not.').optional(),
  solarPanelsOwned: z.enum(['yes', 'no', 'not_stated']).describe('Solar panels owned outright by the seller.').optional(),
  privateWater: z.enum(['yes', 'no', 'not_stated']).describe('Water from a private supply (a well, borehole or spring) rather than the mains.').optional(),
  sectionPages: z.object({ boundaries: z.number().int().min(0), disputes: z.number().int().min(0), notices: z.number().int().min(0), alterations: z.number().int().min(0), guarantees: z.number().int().min(0), insurance: z.number().int().min(0), environment: z.number().int().min(0), rights: z.number().int().min(0), occupiers: z.number().int().min(0), services: z.number().int().min(0), leasehold: z.number().int().min(0) }).describe('The page each section starts on; 0 if the section is absent.'),
  notKnown: z.array(z.object({ question: z.string().describe('The question as printed, with its number (e.g. "4.2 Has any building work been carried out?")'), section: z.string().describe('The section heading; empty string if none'), page: z.number().int().min(0) })).describe('Every question the seller answered "not known", "don\'t know", "no information" or left blank where an answer was required.'),
  disclosures: z.array(flagSchema).describe('Anything else the SELLER discloses that a buyer\'s conveyancer must act on and the fields above do not capture (a covenant breach admitted, a right of pre-emption, an ongoing planning application, an outstanding invoice for works). Never a remark about this document itself: which forms it contains or lacks is given by `forms`, not here.'),
  scanQuality: z.enum(['good', 'fair', 'poor', 'unreadable']),
  confidence: conf,
});

export const IdCheckExtractionSchema = z.object({
  pages: PageLedgerSchema,
  documentKind: z.enum(['provider_report', 'identity_document', 'other']).describe("provider_report = an ID/AML check provider's result; identity_document = a photo or scan of the identity document itself; other = neither."),
  identity: z.object({
    documentType: z.enum(['passport', 'driving_licence', 'national_identity_card', 'residence_permit', 'other']),
    fullName: z.string().describe('The holder\'s full name exactly as printed (given names then surname).'),
    dateOfBirth: z.string().nullable().describe('YYYY-MM-DD'),
    expiryDate: z.string().nullable().describe('YYYY-MM-DD'),
    issuingCountry: z.string().nullable(),
    photoPresent: z.boolean(),
    wholeDocumentVisible: z.boolean().describe('All four corners and every printed field can be seen.'),
    signsOfAlteration: z.array(z.string()).describe('Anything that looks edited, covered, mismatched or not genuine; empty when nothing does.'),
  }).nullable().describe('Only for an identity_document. Never record the document number.'),
  provider: z.string().describe('For a provider_report, the provider; otherwise an empty string.'),
  subjectNames: z.array(z.string()),
  outcome: z.enum(['clear', 'refer', 'fail']),
  checkDate: z.string(),
  flags: z.array(flagSchema).describe('PEP/sanctions matches, address mismatches, document failures.'),
  scanQuality: z.enum(['good', 'fair', 'poor', 'unreadable']),
  confidence: conf,
});

// ───────────────────────────── taxonomy + normalisation (deterministic) ─────────────────────────────

/** Known codes and the LOWEST severity they may be reported at. The model may raise, never lower. */
export const MIN_SEVERITY: Record<string, Severity> = {
  // lease and management pack
  SHORT_LEASE: 'medium',
  GROUND_RENT_HIGH: 'medium',
  GROUND_RENT_DOUBLING: 'high',
  LEASE_ALIENATION_ABSOLUTE: 'high',
  ONEROUS_COVENANT: 'medium',
  FORFEITURE_ON_BANKRUPTCY: 'medium',
  SERVICE_CHARGE_ARREARS: 'medium',
  MAJOR_WORKS_PLANNED: 'medium',
  SECTION_20_NOTICE: 'medium',
  NO_BUILDINGS_INSURANCE: 'high',
  RESERVE_FUND_NONE: 'low',
  LEASEHOLD_DISPUTE: 'high',
  ACCOUNTS_MISSING: 'low',
  HIGH_LANDLORD_FEES: 'low',
  PLANNING_ENFORCEMENT: 'high',
  BREACH_OF_CONDITION: 'high',
  CONTAMINATED_LAND: 'high',
  FLOOD_RISK_HIGH: 'high',
  COMPULSORY_PURCHASE: 'high',
  LISTED_BUILDING: 'medium',
  CONSERVATION_AREA: 'low',
  TREE_PRESERVATION_ORDER: 'low',
  ARTICLE_4_DIRECTION: 'medium',
  ROAD_UNADOPTED: 'medium',
  ROAD_PROPOSALS: 'medium',
  CIL_LIABILITY: 'medium',
  S106_AGREEMENT: 'medium',
  STOP_NOTICE: 'high',
  PRIVATE_WATER_SUPPLY: 'medium',
  FINANCIAL_CHARGE: 'medium',
  DRAINAGE_NOT_CONNECTED: 'medium',
  BUILD_OVER_AGREEMENT: 'medium',
  PUBLIC_SEWER_WITHIN_3M: 'low',
  FLOOD_RISK_MEDIUM: 'medium',
  FLOOD_RISK_LOW: 'low',
  RADON_AFFECTED: 'low',
  MINING_AREA: 'medium',
  CHANCEL_LIABILITY: 'medium',
  PEP_MATCH: 'medium',
  SANCTIONS_MATCH: 'high',
  MINOR_PARTY: 'high',
  ADDRESS_MISMATCH: 'medium',
  DOCUMENT_FAILED: 'high',
};

const SEV_RANK: Record<Severity, number> = { info: 0, low: 1, medium: 2, high: 3 };
const maxSeverity = (a: Severity, b: Severity): Severity => (SEV_RANK[a] >= SEV_RANK[b] ? a : b);

export const normaliseCode = (code: string): string =>
  code
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'UNSPECIFIED';

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/** Scan quality caps confidence: a "poor" scan can never be read with 0.95 certainty. */
const QUALITY_CAP: Record<'good' | 'fair' | 'poor' | 'unreadable', number> = { good: 1, fair: 0.9, poor: 0.6, unreadable: 0 };

type RawFlag = z.infer<typeof flagSchema>;

export function normaliseFlags(raw: RawFlag[]): { flags: Flag[]; minConfidence: number } {
  let min = 1;
  const flags = raw.map((f) => {
    const code = normaliseCode(f.code);
    const sev = maxSeverity(f.severity, MIN_SEVERITY[code] ?? 'info');
    min = Math.min(min, clamp01(f.confidence));
    return { code, severity: sev, description: f.description.trim(), locator: { page: f.locator.page, section: f.locator.section || undefined, quote: f.locator.quote || undefined } };
  });
  return { flags, minConfidence: min };
}

/** Overall confidence = min(document confidence, every item's confidence), capped by scan quality. */
export function overallConfidence(docConfidence: number, itemConfidences: number[], scanQuality: keyof typeof QUALITY_CAP): number {
  const floor = Math.min(clamp01(docConfidence), ...itemConfidences.map(clamp01));
  return Math.min(floor, QUALITY_CAP[scanQuality]);
}

export function toSearchFacts(out: z.infer<typeof SearchExtractionSchema>, expected: SearchType): SearchFacts {
  const { flags, minConfidence } = normaliseFlags(out.flags);
  const summaryFields: Record<string, string> = {};
  for (const f of out.summaryFields) summaryFields[f.label] = f.value;
  const mismatch = out.searchType !== expected;
  if (mismatch) {
    flags.push({ code: 'SEARCH_TYPE_MISMATCH', severity: 'medium', description: `Document reads as a ${out.searchType} search but a ${expected} search was expected.`, locator: { page: 1 } });
  }
  const searchDate = /^\d{4}-\d{2}-\d{2}/.test(out.searchDate ?? '') ? out.searchDate.slice(0, 10) : null;
  return { searchType: expected, flags, confidence: overallConfidence(out.confidence, [minConfidence], out.scanQuality), summaryFields, searchDate };
}

export function toEnquiryReplyFacts(out: z.infer<typeof EnquiryReplyExtractionSchema>, enquiryId: string): EnquiryReplyFacts | null {
  const match = out.replies.find((r) => referencesMatch(r.enquiryReference, enquiryId)) ?? (out.replies.length === 1 ? out.replies[0] : null);
  if (!match) return null;
  const { flags, minConfidence } = normaliseFlags(match.issues);
  const replyText = match.replyText.trim().slice(0, 600) || null;
  return { enquiryId, status: match.status, issues: flags, confidence: overallConfidence(out.confidence, [match.confidence, minConfidence], out.scanQuality), replyText, locator: { page: match.locator.page, section: match.locator.section || undefined, quote: match.locator.quote || undefined } };
}

/** "E1" ≈ "1" ≈ "Enquiry 1" ≈ "e1", but "E1" ≠ "E11" and "E2" ≠ "E2-F1" (a follow-up is its own enquiry). */
const GENERIC_PREFIXES = new Set(['', 'E', 'ENQ', 'ENQUIRY', 'ENQUIRIES', 'Q', 'QUESTION', 'ADDITIONAL', 'ADDITIONALENQUIRY', 'NO', 'NUMBER', 'ITEM', 'REPLY', 'REPLYTO']);
export function referencesMatch(a: string, b: string): boolean {
  // An enquiry raised from an issue is keyed "ISS-10-E1"; the other side replies to "E1".
  const norm = (s: string) => s.toUpperCase().replace(/^ISS-\d+-/, '').replace(/[^A-Z0-9]+/g, '');
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const digits = (s: string) => s.replace(/[^0-9]/g, '');
  const letters = (s: string) => s.replace(/[^A-Z]/g, '');
  if (!digits(na) || digits(na) !== digits(nb)) return false;
  const la = letters(na);
  const lb = letters(nb);
  return la === lb || GENERIC_PREFIXES.has(la) || GENERIC_PREFIXES.has(lb);
}

export function toMortgageFacts(out: z.infer<typeof MortgageOfferExtractionSchema>): MortgageOfferFacts {
  const conditions = out.conditions.map((c) => ({ code: normaliseCode(c.code), text: c.text.trim(), standard: c.standard, locator: { page: c.locator.page, section: c.locator.section || undefined, quote: c.locator.quote || undefined } }));
  return {
    lender: out.lender.trim() || 'unknown lender',
    borrowerNames: out.borrowerNames.map((n) => n.trim()).filter(Boolean),
    propertyAddress: out.propertyAddress.trim() || null,
    purchasePricePennies: out.purchasePricePennies || null,
    amountPennies: out.amountPennies || undefined,
    expiryDate: out.expiryDate || undefined,
    conditions,
    confidence: overallConfidence(out.confidence, out.conditions.map((c) => c.confidence), out.scanQuality),
  };
}

export function toTitleFacts(out: z.infer<typeof TitleExtractionSchema>): TitleFacts {
  const entry = (e: z.infer<typeof titleEntry>) => ({ code: normaliseCode(e.code), text: e.text.trim(), register: e.register, locator: { page: e.locator.page, section: e.locator.section || undefined, quote: e.locator.quote || undefined } });
  const all = [...out.restrictions, ...out.charges, ...out.covenants];
  return {
    titleNumber: out.titleNumber.trim().toUpperCase() || 'UNKNOWN',
    tenure: out.tenure,
    planOnly: out.planOnly,
    unregistered: out.unregistered,
    restrictions: out.restrictions.map(entry),
    charges: out.charges.map(entry),
    covenants: out.covenants.map(entry),
    notices: (out.notices ?? []).map(entry),
    propertyEntries: (out.propertyEntries ?? []).map(entry),
    pendingApplications: (out.pendingApplications ?? []).map((x) => x.trim()).filter(Boolean),
    proprietors: (out.registeredProprietors ?? []).map((n) => n.trim()).filter(Boolean),
    proprietorAddresses: (out.proprietorAddresses ?? []).map((n) => n.trim()).filter(Boolean),
    proprietorSince: /^\d{4}-\d{2}-\d{2}/.test(out.proprietorSince ?? '') ? out.proprietorSince.slice(0, 10) : null,
    pricePaidPennies: out.pricePaidPennies > 0 ? out.pricePaidPennies : null,
    titleClass: out.titleClass ?? 'unknown',
    propertyDescription: out.propertyDescription?.trim() || null,
    editionDate: /^\d{4}-\d{2}-\d{2}/.test(out.editionDate ?? '') ? out.editionDate.slice(0, 10) : null,
    confidence: overallConfidence(out.confidence, all.map((e) => e.confidence), out.scanQuality),
  };
}

const orNull = (s: string) => (s.trim() ? s.trim() : null);
const orNullN = (n: number) => (n > 0 ? n : null);

export function toLeaseFacts(out: z.infer<typeof LeaseExtractionSchema>): LeaseFacts {
  const { flags, minConfidence } = normaliseFlags(out.flags);
  const loc = (l: { page: number; section: string; quote: string }) => ({ page: l.page, section: l.section || undefined, quote: l.quote || undefined });
  const clauses = out.clauses.map((c) => ({ code: c.code.trim(), topic: c.topic, text: c.text.trim(), locator: loc(c.locator) }));
  const rentClause = clauses.find((c) => c.topic === 'rent');
  return {
    demise: orNull(out.demise),
    landlord: orNull(out.landlord),
    managementCompany: orNull(out.managementCompany),
    termYears: orNullN(out.termYears),
    termStartDate: orNull(out.termStartDate),
    leaseDate: orNull(out.leaseDate),
    unexpiredYears: orNullN(out.unexpiredYears),
    groundRentPenniesPa: out.groundRentPenniesPa > 0 ? out.groundRentPenniesPa : null,
    groundRentReview: orNull(out.groundRentReview),
    serviceChargeProportion: orNull(out.serviceChargeProportion),
    repairs: orNull(out.repairs),
    alienation: orNull(out.alienation),
    alterations: orNull(out.alterations),
    permittedUse: orNull(out.permittedUse),
    insurance: orNull(out.insurance),
    landlordNotices: orNull(out.landlordNotices),
    forfeiture: orNull(out.forfeiture),
    locator: rentClause?.locator ?? clauses[0]?.locator,
    clauses,
    flags,
    confidence: overallConfidence(out.confidence, [...out.clauses.map((c) => c.confidence), minConfidence], out.scanQuality),
  };
}

export function toManagementPackFacts(out: z.infer<typeof ManagementPackExtractionSchema>): ManagementPackFacts {
  const { flags, minConfidence } = normaliseFlags(out.flags);
  const loc = (l: { page: number; section: string; quote: string }) => ({ page: l.page, section: l.section || undefined, quote: l.quote || undefined });
  const fees = { noticeOfAssignmentPennies: orNullN(out.feeNoticeOfAssignmentPennies), noticeOfChargePennies: orNullN(out.feeNoticeOfChargePennies), deedOfCovenantPennies: orNullN(out.feeDeedOfCovenantPennies), certificateOfCompliancePennies: orNullN(out.feeCertificateOfCompliancePennies), other: orNull(out.feesOther) };
  return {
    landlord: orNull(out.landlord),
    managingAgent: orNull(out.managingAgent),
    serviceChargePenniesPa: orNullN(out.serviceChargePenniesPa),
    serviceChargePeriod: orNull(out.serviceChargePeriod),
    serviceChargeProportion: orNull(out.serviceChargeProportion),
    groundRentPenniesPa: orNullN(out.groundRentPenniesPa),
    arrearsPennies: out.arrearsPennies,
    reserveFundPennies: orNullN(out.reserveFundPennies),
    majorWorksPlanned: out.majorWorksPlanned,
    majorWorks: orNull(out.majorWorks),
    section20Notice: out.section20Notice,
    buildingsInsuranceInPlace: out.buildingsInsuranceInPlace,
    insurer: orNull(out.insurer),
    insuredSumPennies: orNullN(out.insuredSumPennies),
    insuranceExpiryDate: orNull(out.insuranceExpiryDate),
    fees: Object.values(fees).some((v) => v != null) ? fees : null,
    consentsRequired: orNull(out.consentsRequired),
    disputes: orNull(out.disputes),
    buildingSafety: out.bsaRelevantBuilding === 'not_stated' && out.bsaLeaseholderDeedOfCertificate === 'not_stated' && out.bsaLandlordCertificate === 'not_stated' && !out.bsaRemediation ? null : { relevantBuilding: out.bsaRelevantBuilding === 'not_stated' ? null : out.bsaRelevantBuilding === 'yes', leaseholderDeedOfCertificate: out.bsaLeaseholderDeedOfCertificate === 'not_stated' ? null : out.bsaLeaseholderDeedOfCertificate === 'yes', landlordCertificate: out.bsaLandlordCertificate === 'not_stated' ? null : out.bsaLandlordCertificate === 'yes', remediation: orNull(out.bsaRemediation) },
    accountsProvided: orNull(out.accountsProvided),
    entries: out.entries.map((e) => ({ code: e.code.trim(), text: e.text.trim(), locator: loc(e.locator) })),
    flags,
    confidence: overallConfidence(out.confidence, [...out.entries.map((e) => e.confidence), minConfidence], out.scanQuality),
  };
}

export function toContractFacts(out: z.infer<typeof ContractExtractionSchema>): ContractFacts {
  const { flags, minConfidence } = normaliseFlags(out.flags);
  const loc = (l: { page: number; section: string; quote: string }) => ({ page: l.page, section: l.section || undefined, quote: l.quote || undefined });
  return {
    sellers: out.sellers.map((s) => s.trim()).filter(Boolean),
    buyers: out.buyers.map((s) => s.trim()).filter(Boolean),
    propertyAddress: out.propertyAddress.trim(),
    titleNumber: out.titleNumber.trim().toUpperCase() || null,
    pricePennies: out.pricePennies || null,
    depositPennies: out.depositPennies || null,
    depositHolder: out.depositHolder.trim() || null,
    completionDate: out.completionDate.trim() || null,
    chattelsPricePennies: out.chattelsPricePennies || null,
    vat: out.vat.trim() || null,
    incorporatedConditions: out.incorporatedConditions.trim() || null,
    noticeToCompleteDays: out.noticeToCompleteDays || null,
    fixturesListPresent: out.fixturesListPresent,
    specialConditions: out.specialConditions.map((c) => ({ code: normaliseCode(c.code), text: c.text.trim(), locator: loc(c.locator) })),
    indemnities: out.indemnities.map((c) => ({ text: c.text.trim(), locator: loc(c.locator) })),
    flags,
    signedBy: (out.signedBy ?? []).map((s) => s.trim()).filter(Boolean),
    dated: !!out.dated,
    confidence: overallConfidence(out.confidence, [minConfidence, ...out.specialConditions.map((c) => c.confidence)], out.scanQuality),
  };
}

export function toPropertyFormsFacts(out: z.infer<typeof PropertyFormsExtractionSchema>): PropertyFormsFacts {
  const yn = (v: string): boolean | null => (v === 'yes' ? true : v === 'no' ? false : null);
  const t = (v: string): string | null => (v.trim() ? v.trim() : null);
  const pg = (n: number): number | undefined => (n > 0 ? n : undefined);
  const sp = out.sectionPages;
  return {
    forms: out.forms,
    disclosures: out.disclosures.map((f) => ({ code: f.code, severity: f.severity, description: f.description, locator: f.locator ?? undefined, confidence: f.confidence })),
    confidence: out.confidence,
    answers: {
      disputes: t(out.disputes), notices: t(out.notices), alterations: t(out.alterations), alterationsConsented: yn(out.alterationsConsented), alterationsDocumentsEnclosed: yn(out.alterationsDocumentsEnclosed), listedOrConservation: yn(out.listedOrConservation),
      guaranteesOutstandingClaims: t(out.guaranteesOutstandingClaims), insuranceClaims: t(out.insuranceClaims), insuranceRefused: yn(out.insuranceRefused), flooded: yn(out.flooded), floodDetail: t(out.floodDetail),
      japaneseKnotweed: out.japaneseKnotweed === 'yes' ? true : out.japaneseKnotweed === 'no' ? false : null, knotweedDetail: t(out.knotweedDetail), radonTestAboveAction: yn(out.radonTestAboveAction), occupiers: t(out.occupiers),
      sharedAccessOrServices: yn(out.sharedAccessOrServices), rightsOfWayOverProperty: t(out.rightsOfWayOverProperty), septicTank: yn(out.septicTank), solarPanelsLeased: yn(out.solarPanelsLeased), boundariesUnclear: t(out.boundariesUnclear),
      leaseholdArrearsOrDispute: yn(out.leaseholdArrearsOrDispute), epcRating: t(out.epcRating), councilTaxBand: t(out.councilTaxBand),
      alterationsYear: t(out.alterationsYear ?? ''), windowsReplacedSince2002: yn(out.windowsReplacedSince2002 ?? 'not_stated'), windowsCertificate: yn(out.windowsCertificate ?? 'not_stated'), electricalWorkSince2005: yn(out.electricalWorkSince2005 ?? 'not_stated'), electricalCertificate: yn(out.electricalCertificate ?? 'not_stated'), gasApplianceNoRecord: yn(out.gasApplianceNoRecord ?? 'not_stated'), knotweedCategory: t(out.knotweedCategory ?? ''), solarPanelsOwned: yn(out.solarPanelsOwned ?? 'not_stated'), privateWater: yn(out.privateWater ?? 'not_stated'),
    },
    notKnown: out.notKnown.map((q) => ({ question: q.question, section: q.section || null, page: q.page > 0 ? q.page : null })),
    pages: { boundaries: pg(sp.boundaries), disputes: pg(sp.disputes), notices: pg(sp.notices), alterations: pg(sp.alterations), guarantees: pg(sp.guarantees), insurance: pg(sp.insurance), environment: pg(sp.environment), rights: pg(sp.rights), occupiers: pg(sp.occupiers), services: pg(sp.services), leasehold: pg(sp.leasehold) },
  };
}

export function toIdCheckFacts(out: z.infer<typeof IdCheckExtractionSchema>): IdCheckFacts {
  const { flags, minConfidence } = normaliseFlags(out.flags);
  const confidence = overallConfidence(out.confidence, [minConfidence], out.scanQuality);
  if (out.documentKind !== 'provider_report') {
    const i = out.documentKind === 'identity_document' ? out.identity : null;
    return { provider: 'Document photo', outcome: 'refer', flags: [], confidence, source: 'document', identity: i ? { ...i, legibility: out.scanQuality } : null, notIdentity: out.documentKind === 'other' };
  }
  return { provider: out.provider.trim() || 'unknown', outcome: out.outcome, flags, confidence };
}

// ───────────────────────────── prompts ─────────────────────────────

const TAXONOMY =
  'Flag code taxonomy (use these where they fit; invent UPPER_SNAKE codes only for genuinely new findings): ' +
  Object.keys(MIN_SEVERITY).join(', ') +
  '. Severity guide: high = would normally stop or reprice the purchase or needs urgent action (enforcement, contamination, sanctions); ' +
  'medium = needs a decision, further enquiry or indemnity before exchange; low = must be reported to the client but is usually acceptable; ' +
  'info = routine confirmation worth recording (road adopted, no entries).';

const SCAN_NOTE =
  'The document may be a scan of variable quality. Read every page. Where a page is illegible or partially legible, ' +
  'report what you can, set scanQuality accordingly and LOWER the confidence of anything you had to infer. Never fill a gap with a plausible value.';

const PROMPTS = {
  contract: `Extract this contract for the sale and purchase of land (a draft, an approved draft or an engrossment). Name every seller and buyer exactly as printed, the property, the title number, the price, the deposit and who holds it, any fixed completion date, chattels, VAT wording, the standard conditions incorporated and the notice-to-complete period. Copy every special condition verbatim with its number and page, and every indemnity term. Flag anything a conveyancer must decide on before approval. Return a verdict for every page.`,
  lease: `Extract this residential lease (the lease itself, a counterpart, a deed of variation or the lease with its plan) for a buyer. Read the parties, the demise, the term and its start, the ground rent and every review provision, the service charge proportion, the repairing obligations of lessee and lessor, assignment and underletting, alterations, use, insurance, the notices and fees the lease fixes on assignment or charge, and forfeiture. Compute the unexpired term from today's date. Copy every clause you rely on verbatim with its page. State facts, never advice. ${TAXONOMY} ${SCAN_NOTE}`,
  management_pack: `Extract this leasehold information pack (LPE1, LPE2, the managing agent's pack or the landlord's replies) for a buyer. Read every question and enclosure: the landlord and managing agent, the service charge for this flat and the year it covers, the proportion, the ground rent, arrears, the reserve fund, major works planned or consulted on (section 20), buildings insurance and its expiry, every fee charged on sale, the consents required, any dispute or breach, and which accounts and budgets are enclosed. Copy every answer you rely on verbatim with its question number and page. State facts, never advice. ${TAXONOMY} ${SCAN_NOTE}`,
  classify: `Classify this conveyancing document. Decide which engine sub-flow it belongs to: a search result (LLC1 local land charges, CON29 local authority enquiries, drainage & water, environmental, chancel), replies to enquiries from the seller's solicitor, a mortgage offer, an official copy of the register of title (HM Land Registry: the A, B and C registers as text), a requisition from HM Land Registry on a registration application (a letter or notice from HMLR asking for something before it can complete an application: hmlr_requisition), a title plan (the Land Registry plan: a map of the land with a title number, edged red, and no register entries; classify it as title_plan, never as title), the seller's property information forms (Law Society TA6 Property Information Form, TA7 Leasehold Information Form, TA10 Fittings and Contents Form, TA13 Completion Information: classify these as property_forms, never as a supporting document), a supporting document supplied with the contract pack to back up the seller's replies (never the TA forms themselves: an indemnity insurance policy such as sewer, lack of building regulations or restrictive covenant cover; a planning permission or decision notice; a building regulations completion certificate; a guarantee or warranty for damp-proofing, timber, windows, a roof or a new build; a gas safety, electrical or FENSA certificate; an EPC), an ID/AML check report or a photo or scan of a person's identity document (passport, driving licence, national identity card, residence permit) = id_check, a contract/transfer, a survey or valuation report (RICS level 1/2/3, homebuyer, building survey, mortgage valuation), a specialist's report following a survey (damp, timber, drainage, structural, electrical, roofing, asbestos, Japanese knotweed), a leasehold management pack (the LPE1 or the managing agent's replies; the TA7 is property_forms, not this), a lease (the lease deed itself, a counterpart or a deed of variation), or other. ${SCAN_NOTE}`,
  property_forms: `Read the seller's property information forms (Law Society TA6, and TA7 on a leasehold, TA10 fittings and contents) for a buyer's conveyancer. Go section by section and copy the seller's answer to each question that matters verbatim: boundaries, disputes and complaints, notices and proposals, alterations and the consents for them, guarantees and claims, insurance, environmental matters (flooding, radon, Japanese knotweed), rights and shared services, parking, other charges, occupiers, services and drainage, solar panels, and on the TA7 the service charge, arrears and disputes. Record the page each section starts on. An answer of "no", "not known" or blank is reported as such, never inferred. ${TAXONOMY} ${SCAN_NOTE}`,
  survey: `Read this survey, valuation or specialist report for a house buyer. Extract every recommendation the author makes that needs something done: every element rated 3 or 2, every further investigation, every urgent or safety point. Leave out elements rated 1 or not inspected, and general maintenance advice. Keep each item to one or two sentences in the report's own words (not whole paragraphs). For each say whether it recommends a FURTHER specialist investigation or report before purchase (as opposed to routine maintenance or a note). Name the specialist recommended if the report does. Grade severity as the report does (high for structural / safety / "urgent", medium for "should be investigated", low for advisory), and give the RICS condition rating (3 / 2 / 1) where the report rates the element; include every condition rating 3 item. Separately, list every point the surveyor raises for the legal adviser (the "Issues for your legal advisers" section: regulation, guarantees, other matters such as rights of way, boundaries, shared services, tenancies), the risks section, the market value and the reinstatement cost. Do not judge whether the buyer should proceed. ${SCAN_NOTE}`,
  search: `Extract the findings of this property search as typed facts. ${TAXONOMY} Include informational entries so the handler can see what was checked. ${SCAN_NOTE}`,
  enquiry: `Extract the seller's solicitor's replies to pre-contract enquiries. For each reply, decide whether it fully answers the question ("answered"), only partly ("partial"), declines ("refused" — e.g. "the buyer must rely on their own survey/searches" where a factual answer was asked), or is unclear. Record any issue the reply reveals as a flag. ${TAXONOMY} ${SCAN_NOTE}`,
  mortgage: `Extract the terms and conditions of this mortgage offer. Mark a condition as standard ONLY if it is boilerplate that appears in every offer from this lender (general conditions); anything specific to this borrower or property — retentions, repairs, occupier consents, evidence of deposit source, valuation conditions, lease requirements — is NOT standard. ${SCAN_NOTE}`,
  supporting: `Read this document supplied by the seller's solicitor to support the property information forms, for a buyer's conveyancer. Say what kind it is (indemnity_policy, planning_permission, building_regs, guarantee, certificate, other), its title, exactly what it covers or approves (the risk insured, the works permitted or certified), who issued it, its reference, its date and any expiry. For an indemnity policy give the limit of indemnity and whether the cover passes to the buyer, their successors in title and their mortgagee (true / false; null if the policy does not say). Give the property it names as printed. Copy any condition or exclusion that matters. Do not infer anything the document does not state. ${SCAN_NOTE}`,
  titlePlan: `Read this HM Land Registry title plan for a buyer's conveyancer. Give its title number; describe what the red edging encloses (the building and garden, a garage, a strip, a drive), and every other colour, hatching, tinting or numbered marking with what the plan's key or notes say it marks (green = land removed from the title, brown or blue tinting = rights, numbered = a note or a lease). Copy any notes on the plan and its date, scale or OS reference. Do not invent a meaning the plan does not state: say 'not stated on the plan'. ${SCAN_NOTE}`,
  title: `Extract the register of title. Capture every entry from the proprietorship (B) and charges (C) registers verbatim, and every covenant, easement or right from the property (A) register. Tenure must be read from the register heading. ${SCAN_NOTE}`,
  idCheck: `Say what this is. If it is an identity / anti-money-laundering check report from a provider, extract its outcome and any PEP, sanctions, adverse media, address or document flags. If it is a photo or scan of an identity document itself (passport, driving licence, identity card, residence permit), fill in identity from what is printed on it, set provider to "" and outcome to "refer" (a photo is never a completed check), and list nothing in flags. If it is neither, say so (documentKind other, outcome refer). Do not record document or passport numbers. ${SCAN_NOTE}`,
  statement: `This document was attached by a house buyer as evidence of where their money comes from. If it is a bank, building society or e-money account statement, extract EVERY transaction line in the period exactly as printed (date, description including references, signed amount in pennies, running balance if shown, the counterparty name if the line shows one) and identify credits that are clearly salary or regular income. Never extract the full account number — the last four digits only. If it is not a statement, say what it is. A payslip: give the employee's name, the employer, the pay date and the net and gross pay in pennies, and leave the transactions empty. Anything else (a gift letter, an identity document, a contract): say so and leave the transactions empty. ${SCAN_NOTE}`,
};

// ───────────────────────────── loading document bytes ─────────────────────────────

export interface DocumentBytesLoader {
  /** The document as the model should see it, or null when nothing readable exists. */
  load(doc: DocumentRef): Promise<EngineDocumentInput | null>;
}

export interface DocumentFactsWriter {
  /** Persist extraction output on the document (document.extracted_facts) for reuse and audit. */
  write(doc: DocumentRef, facts: unknown, confidence: number, meta: { role: string; model: string; promptHash: string; contentHash: string }): Promise<void>;
  /** Persist the coverage ledger and the fact register for this read (document_page, document_fact). */
  writeReview?(doc: DocumentRef, review: DocumentReview, extractor: string, texts?: PageTexts): Promise<void>;
}

/** Facts already persisted by a previous run of THIS pipeline (not a hand-seeded fixture). */
interface PersistedFacts {
  _pipeline?: { role: string; contentHash: string; model: string; promptHash: string; at: string };
  facts?: unknown;
}

// ───────────────────────────── the extractor ─────────────────────────────

export class ClaudeExtractor implements DocumentExtractor {
  readonly name: string;

  constructor(
    private llm: StructuredLlm,
    private loader: DocumentBytesLoader,
    private writer: DocumentFactsWriter | null,
    private opts: { model: string; effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'; classifyModel?: string; criticalModel?: string } = { model: 'claude-sonnet-5' }
  ) {
    this.name = `claude-extractor:${opts.model}`;
  }

  private async input(doc: DocumentRef): Promise<{ input: EngineDocumentInput; contentHash: string }> {
    const input = await this.loader.load(doc);
    if (!input) throw new Error(`Document ${doc.id} has no readable content.`);
    const contentHash = crypto.createHash('sha256').update(input.data).digest('hex');
    return { input, contentHash };
  }

  private cached<T>(doc: DocumentRef, role: string, contentHash: string): T | null {
    const p = doc.extractedFacts as PersistedFacts | null;
    if (p?._pipeline && p._pipeline.role === role && p._pipeline.contentHash === contentHash && p.facts) return p.facts as T;
    return null;
  }

  private async run<S extends z.ZodType>(doc: DocumentRef, role: string, schema: S, instructions: string, prompt: string, feature: 'DOC_CLASSIFY' | 'DOC_EXTRACT', tune: { maxTokens?: number; effort?: 'low' | 'medium' | 'high' } = {}) {
    const { input: full, contentHash } = await this.input(doc);
    // What it costs to read depends on what is being read: the opening pages to say what a document is;
    // the whole text for most; the PDF itself, on the strongest model, where a misread is expensive.
    const base = role.split(':')[0];
    const critical = CRITICAL_ROLES.has(base);
    const classify = base === 'classify';
    const model = classify ? this.opts.classifyModel ?? this.opts.model : critical ? this.opts.criticalModel ?? this.opts.model : this.opts.model;
    const effort = tune.effort ?? (classify ? 'low' : critical ? 'high' : 'medium');
    // A long PDF (a 150-page lease) is read in sections, each with the same instructions, and the readings merged (sections.ts).
    const sections = !classify && full.kind === 'pdf' ? await pdfSections(full.data) : null;
    if (sections) {
      const read = async (sec: PdfSection) => {
        const part = await leanDocument({ kind: 'pdf', data: sec.data, title: full.title }, { keepPdf: critical });
        const res = await this.llm.call<z.infer<S>>({
          schema: schema as unknown as z.ZodType<z.infer<S>>,
          instructions,
          documents: [{ ...part, title: `${doc.fileName ?? doc.id} (pages ${sec.firstPage}–${sec.lastPage} of ${sec.total})` }],
          prompt: `${prompt}\n\nThis is one part of a ${sec.total}-page document: its pages ${sec.firstPage} to ${sec.lastPage}, sent separately because of its length. Report what is on these pages only. Number pages as they are numbered in this part (its first page is 1). Leave out anything these pages do not state.`,
          model,
          effort,
          maxTokens: tune.maxTokens,
          meter: { tenantId: doc.tenantId, matterId: doc.matterId, feature },
        });
        return { out: shiftPages(res.output, sec.firstPage - 1), model: res.model, promptHash: res.promptHash };
      };
      // Three at a time: quicker than one by one, without a burst of rate-limited calls.
      const parts: Array<{ out: z.infer<S>; model: string; promptHash: string }> = [];
      for (let i = 0; i < sections.length; i += 3) parts.push(...(await Promise.all(sections.slice(i, i + 3).map(read))));
      return { out: mergeReadings(parts.map((x) => x.out)), contentHash, model: parts[0].model, promptHash: parts[0].promptHash };
    }
    const input = await leanDocument(full, { keepPdf: critical, firstPages: classify ? 3 : undefined });
    const res = await this.llm.call<z.infer<S>>({
      schema: schema as unknown as z.ZodType<z.infer<S>>,
      instructions,
      documents: [{ ...input, title: doc.fileName ?? doc.id }],
      prompt,
      model,
      effort,
      maxTokens: tune.maxTokens ?? (classify ? 2_000 : undefined),
      meter: { tenantId: doc.tenantId, matterId: doc.matterId, feature },
    });
    return { out: res.output, contentHash, model: res.model, promptHash: res.promptHash };
  }

  private texts = new Map<string, Promise<PageTexts>>();
  /** The document's own page text, for verifying quotes; cached per content hash. Text documents are one page; images have no text layer. */
  private pageTexts(input: EngineDocumentInput, contentHash: string): Promise<PageTexts> {
    let p = this.texts.get(contentHash);
    if (!p) {
      p = pageTextsWithOcr(input).catch(() => ({ pages: [], textLayer: false }));
      this.texts.set(contentHash, p);
    }
    return p;
  }

  private async persist(doc: DocumentRef, role: string, facts: unknown, confidence: number, meta: { model: string; promptHash: string; contentHash: string }, ledger?: z.infer<typeof PageLedgerSchema> | null, raw?: unknown) {
    if (!this.writer) return;
    await this.writer.write(doc, { _pipeline: { role, ...meta, at: new Date().toISOString() }, facts }, confidence, { role, ...meta }).catch(() => {});
    if (this.writer.writeReview && ledger !== undefined) {
      try {
        const input = await this.loader.load(doc);
        const texts = input ? await this.pageTexts(input, meta.contentHash) : { pages: [], textLayer: false };
        await this.writer.writeReview(doc, buildReview({ role, facts, ledger, texts, raw }), this.name, texts);
      } catch {
        /* the review is a projection; a failure here never fails the read */
      }
    }
  }

  async classify(doc: DocumentRef): Promise<Classification> {
    const ask = () => this.run(doc, 'classify', ClassificationSchema, PROMPTS.classify, `File name: ${doc.fileName ?? 'unknown'}. Classify the document.`, 'DOC_CLASSIFY');
    // An answer that fails the schema (a stray value) is one-off; one more try costs little and saves the document going unread.
    try { return (await ask()).out; }
    catch (err) {
      if (!(err instanceof EngineLlmError) || err.status !== 502) throw err;
      return (await ask()).out;
    }
  }

  async extractSearch(doc: DocumentRef, searchType: SearchType): Promise<SearchFacts> {
    const { contentHash } = await this.input(doc);
    const hit = this.cached<SearchFacts>(doc, `search:${searchType}`, contentHash);
    if (hit) return hit;
    const { out, model, promptHash } = await this.run(doc, 'search', SearchExtractionSchema, PROMPTS.search, `Expected search type: ${searchType}. Extract this search result.`, 'DOC_EXTRACT');
    const facts = toSearchFacts(out, searchType);
    await this.persist(doc, `search:${searchType}`, facts, facts.confidence, { model, promptHash, contentHash }, out.pages, out);
    return facts;
  }

  async extractEnquiryReply(doc: DocumentRef, enquiryId: string): Promise<EnquiryReplyFacts | null> {
    const { contentHash } = await this.input(doc);
    const hit = this.cached<EnquiryReplyFacts>(doc, `enquiry:${enquiryId}`, contentHash);
    if (hit) return hit;
    const { out, model, promptHash } = await this.run(doc, 'enquiry', EnquiryReplyExtractionSchema, PROMPTS.enquiry, `We raised enquiry "${enquiryId}". Extract every reply in the document; the engine will match the one for "${enquiryId}".`, 'DOC_EXTRACT');
    const facts = toEnquiryReplyFacts(out, enquiryId);
    if (facts) await this.persist(doc, `enquiry:${enquiryId}`, facts, facts.confidence, { model, promptHash, contentHash }, out.pages);
    return facts;
  }

  async extractMortgageOffer(doc: DocumentRef): Promise<MortgageOfferFacts> {
    const { contentHash } = await this.input(doc);
    const hit = this.cached<MortgageOfferFacts>(doc, 'mortgage', contentHash);
    if (hit) return hit;
    const { out, model, promptHash } = await this.run(doc, 'mortgage', MortgageOfferExtractionSchema, PROMPTS.mortgage, 'Extract this mortgage offer.', 'DOC_EXTRACT');
    const facts = toMortgageFacts(out);
    await this.persist(doc, 'mortgage', facts, facts.confidence, { model, promptHash, contentHash }, out.pages, out);
    return facts;
  }

  async extractTitle(doc: DocumentRef): Promise<TitleFacts> {
    const { contentHash } = await this.input(doc);
    const hit = this.cached<TitleFacts>(doc, 'title', contentHash);
    if (hit) return hit;
    const { out, model, promptHash } = await this.run(doc, 'title', TitleExtractionSchema, PROMPTS.title, 'Extract this register of title.', 'DOC_EXTRACT');
    const facts = toTitleFacts(out);
    await this.persist(doc, 'title', facts, facts.confidence, { model, promptHash, contentHash }, out.pages, out);
    return facts;
  }

  async extractSupportingDocument(doc: DocumentRef): Promise<SupportingDocFacts> {
    const { contentHash } = await this.input(doc);
    const hit = this.cached<SupportingDocFacts>(doc, 'supporting_document', contentHash);
    if (hit) return hit;
    const { out, model, promptHash } = await this.run(doc, 'supporting', SupportingDocSchema, PROMPTS.supporting, 'Read this supporting document.', 'DOC_EXTRACT');
    const { pages: _pages, ...rest } = out;
    void _pages;
    const facts: SupportingDocFacts = { ...rest, title: rest.title.trim(), covers: rest.covers.trim(), notes: rest.notes.filter((x) => x.trim()) };
    await this.persist(doc, 'supporting_document', facts, facts.confidence, { model, promptHash, contentHash }, out.pages, out);
    return facts;
  }

  async extractTitlePlan(doc: DocumentRef): Promise<TitlePlanFacts> {
    const { contentHash } = await this.input(doc);
    const hit = this.cached<TitlePlanFacts>(doc, 'title_plan', contentHash);
    if (hit) return hit;
    const { out, model, promptHash } = await this.run(doc, 'titlePlan', TitlePlanSchema, PROMPTS.titlePlan, 'Read this title plan.', 'DOC_EXTRACT');
    const facts: TitlePlanFacts = { titleNumber: out.titleNumber.trim().toUpperCase() || 'UNKNOWN', edgedRed: out.edgedRed.trim(), otherMarkings: out.otherMarkings.filter((m) => m.marking.trim()), notes: out.notes.filter((x) => x.trim()), reference: out.reference.trim(), confidence: out.confidence };
    await this.persist(doc, 'title_plan', facts, facts.confidence, { model, promptHash, contentHash }, out.pages, out);
    return facts;
  }

  async extractPropertyForms(doc: DocumentRef): Promise<PropertyFormsFacts> {
    const { contentHash } = await this.input(doc);
    const hit = this.cached<PropertyFormsFacts>(doc, 'property_forms', contentHash);
    if (hit) return hit;
    const { out, model, promptHash } = await this.run(doc, 'property_forms', PropertyFormsExtractionSchema, PROMPTS.property_forms, "Extract the seller's answers from these property information forms.", 'DOC_EXTRACT');
    const facts = toPropertyFormsFacts(out);
    await this.persist(doc, 'property_forms', facts, facts.confidence, { model, promptHash, contentHash }, out.pages, out);
    return facts;
  }

  async extractSurvey(doc: DocumentRef): Promise<SurveyFacts> {
    const { contentHash } = await this.input(doc);
    const hit = this.cached<SurveyFacts>(doc, 'survey', contentHash);
    // A reading from before the legal-adviser points were asked for is read again.
    if (hit && hit.legalIssues !== undefined) return hit;
    // A Level 3 report runs to fifty pages: room for a long answer, and medium effort so it reads in a minute, not five.
    const { out, model, promptHash } = await this.run(doc, 'survey', SurveyExtractionSchema, PROMPTS.survey, 'Extract the recommendations from this report.', 'DOC_EXTRACT', { maxTokens: 48_000, effort: 'medium' });
    const facts: SurveyFacts = { surveyType: out.surveyType, surveyor: out.surveyor, summary: out.summary, recommendations: out.recommendations.map((r) => ({ code: r.code, text: r.text, furtherInvestigation: r.furtherInvestigation, specialist: r.specialist, severity: r.severity, rating: (r.rating === 1 || r.rating === 2 || r.rating === 3 ? r.rating : null) as 1 | 2 | 3 | null, locator: r.page ? { page: r.page } : undefined })), legalIssues: out.legalIssues.map((l) => ({ category: l.category, text: l.text, locator: l.page ? { page: l.page } : undefined })), risks: out.risks, marketValuePennies: out.marketValuePennies, reinstatementCostPennies: out.reinstatementCostPennies, confidence: out.scanQuality === 'unreadable' ? 0 : out.scanQuality === 'poor' ? Math.min(out.confidence, 0.6) : out.confidence };
    // No page ledger is asked of a survey (it would crowd a long answer): its pages are recorded as unattested, its facts and pages still registered and indexed.
    await this.persist(doc, 'survey', facts, facts.confidence, { model, promptHash, contentHash }, null);
    return facts;
  }

  async extractStatement(doc: DocumentRef): Promise<StatementFacts | null> {
    const { contentHash } = await this.input(doc);
    const read = await this.extractEvidence(doc);
    return read.statement;
  }

  /** Proof of funds: what the client attached, read for what it is — a statement transaction by transaction, a payslip for its pay, anything else named. */
  async extractEvidence(doc: DocumentRef): Promise<{ kind: EvidenceKind; statement: StatementFacts | null; payslip: PayslipFacts | null }> {
    const { contentHash } = await this.input(doc);
    const hit = this.cached<StatementFacts | { notStatement: true; kind?: EvidenceKind; payslip?: PayslipFacts | null }>(doc, 'statement', contentHash);
    if (hit) return 'notStatement' in hit ? { kind: hit.kind ?? 'other', statement: null, payslip: hit.payslip ?? null } : { kind: 'bank_statement', statement: hit, payslip: null };
    const { out, model, promptHash } = await this.run(doc, 'statement', StatementExtractionSchema, PROMPTS.statement, 'Read this document as evidence of source of funds.', 'DOC_EXTRACT');
    if (out.scanQuality === 'unreadable') throw new Error('scan unreadable');
    if (!out.isBankStatement) {
      const kind: EvidenceKind = out.documentKind === 'bank_statement' ? 'other' : out.documentKind;
      const payslip: PayslipFacts | null = kind === 'payslip' && out.payslip ? { ...out.payslip, confidence: out.confidence } : null;
      await this.persist(doc, 'statement', { notStatement: true, kind, payslip }, out.confidence, { model, promptHash, contentHash }, null);
      return { kind, statement: null, payslip };
    }
    const facts: StatementFacts = {
      accountHolder: out.accountHolder,
      bankName: out.bankName,
      accountLast4: out.accountLast4 ? out.accountLast4.slice(-4) : null,
      periodFrom: out.periodFrom,
      periodTo: out.periodTo,
      openingBalancePennies: out.openingBalancePennies,
      closingBalancePennies: out.closingBalancePennies,
      transactions: out.transactions,
      salaryCredits: out.salaryCredits,
      confidence: out.scanQuality === 'poor' ? Math.min(out.confidence, 0.6) : out.confidence,
    };
    await this.persist(doc, 'statement', facts, facts.confidence, { model, promptHash, contentHash }, null);
    return { kind: 'bank_statement', statement: facts, payslip: null };
  }

  async extractLease(doc: DocumentRef): Promise<LeaseFacts> {
    const { contentHash } = await this.input(doc);
    const hit = this.cached<LeaseFacts>(doc, 'lease', contentHash);
    if (hit) return hit;
    const { out, model, promptHash } = await this.run(doc, 'lease', LeaseExtractionSchema, PROMPTS.lease, `Today is ${new Date().toISOString().slice(0, 10)}. Extract this lease.`, 'DOC_EXTRACT');
    const facts = toLeaseFacts(out);
    await this.persist(doc, 'lease', facts, facts.confidence ?? 0, { model, promptHash, contentHash }, out.pages, out);
    return facts;
  }

  async extractManagementPack(doc: DocumentRef): Promise<ManagementPackFacts> {
    const { contentHash } = await this.input(doc);
    const hit = this.cached<ManagementPackFacts>(doc, 'management_pack', contentHash);
    if (hit) return hit;
    const { out, model, promptHash } = await this.run(doc, 'management_pack', ManagementPackExtractionSchema, PROMPTS.management_pack, 'Extract this management pack.', 'DOC_EXTRACT');
    const facts = toManagementPackFacts(out);
    await this.persist(doc, 'management_pack', facts, facts.confidence, { model, promptHash, contentHash }, out.pages, out);
    return facts;
  }

  async extractContract(doc: DocumentRef): Promise<ContractFacts> {
    const { contentHash } = await this.input(doc);
    const hit = this.cached<ContractFacts>(doc, 'contract', contentHash);
    if (hit) return hit;
    const { out, model, promptHash } = await this.run(doc, 'contract', ContractExtractionSchema, PROMPTS.contract, 'Extract this contract.', 'DOC_EXTRACT');
    const facts = toContractFacts(out);
    await this.persist(doc, 'contract', facts, facts.confidence, { model, promptHash, contentHash }, out.pages, out);
    return facts;
  }

  async extractIdCheck(doc: DocumentRef): Promise<IdCheckFacts> {
    const { contentHash } = await this.input(doc);
    const hit = this.cached<IdCheckFacts>(doc, 'id_check', contentHash);
    if (hit) return hit;
    const { out, model, promptHash } = await this.run(doc, 'id_check', IdCheckExtractionSchema, PROMPTS.idCheck, 'Extract this ID/AML check report.', 'DOC_EXTRACT');
    const facts = toIdCheckFacts(out);
    await this.persist(doc, 'id_check', facts, facts.confidence, { model, promptHash, contentHash }, out.pages, out);
    return facts;
  }
}

/** The pipeline's own threshold, re-exported so callers can reason about "will this auto-clear?". */
export { MIN_EXTRACTION_CONFIDENCE, ENGINE_SYSTEM_GUARD };
