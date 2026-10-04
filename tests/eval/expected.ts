/**
 * What a careful conveyancer reads in each eval document (tests/eval/fixtures), written by hand: the
 * document's kind, the facts the register must hold (by key, as review.ts flattenFacts names them),
 * where the key ones are, and questions Ask The File must answer from the whole file.
 *
 *   eq      the value, compared without case or spacing
 *   num     a number (pennies, years)
 *   has     the value contains this (any row whose key starts with `key` when `prefix`)
 *   not     the value must not be this
 *   page    the page the fact must be cited to (when it has one)
 */
export type FactCheck = { key: string; prefix?: boolean; eq?: string; num?: number; has?: RegExp; not?: string; page?: number; why: string };
export interface EvalDocument { file: string; role: string; extract: string; searchType?: string; facts: FactCheck[] }
export interface EvalQuestion { q: string; file: string | null; page?: number; answer: RegExp[]; why: string }

export const DOCUMENTS: EvalDocument[] = [
  {
    file: '01-official-copy', role: 'title', extract: 'title',
    facts: [
      { key: 'title.number', eq: 'WYK884213', why: 'title number' },
      { key: 'title.proprietor.', prefix: true, has: /hargreaves/i, why: 'first proprietor' },
      { key: 'title.proprietor.', prefix: true, has: /shah/i, why: 'second proprietor' },
      { key: 'title.restriction.', prefix: true, has: /consent.*(northgate|charge)|(northgate|charge).*consent/i, why: "the lender's consent restriction" },
      { key: 'title.restriction.', prefix: true, has: /sole proprietor|form a|capital money/i, why: 'the Form A joint proprietor restriction' },
      { key: 'title.charge.', prefix: true, has: /northgate|registered charge/i, page: 2, why: 'the registered charge, on page 2' },
      { key: 'title.covenant.', prefix: true, has: /dwellinghouse|trade or business|extension/i, page: 2, why: 'the 1956 covenants, on page 2' },
    ],
  },
  {
    file: '02-lease', role: 'lease', extract: 'lease',
    facts: [
      { key: 'lease.term_years', num: 125, why: 'term' },
      { key: 'lease.term_start_date', eq: '2005-01-01', why: 'term start' },
      { key: 'lease.date', eq: '2005-01-20', why: 'date of lease' },
      { key: 'lease.ground_rent_pennies_pa', num: 25000, why: 'ground rent £250' },
      { key: 'lease.ground_rent_review', has: /doubl|25/i, why: 'doubling every 25 years' },
      { key: 'lease.landlord', has: /calder wharf/i, why: 'landlord' },
      { key: 'lease.management_company', has: /wharf road/i, why: 'management company' },
      { key: 'lease.service_charge_proportion', has: /8\.33|twelfth|1\/12/i, why: 'service charge share' },
      { key: 'lease.alienation', has: /part|deed of covenant/i, why: 'alienation terms' },
    ],
  },
  {
    file: '03-contract', role: 'contract', extract: 'contract',
    facts: [
      { key: 'contract.price_pennies', num: 42_500_000, why: 'price £425,000' },
      { key: 'contract.deposit_pennies', num: 4_250_000, why: 'deposit £42,500' },
      { key: 'contract.completion_date', eq: '2026-11-13', why: 'completion date' },
      { key: 'contract.title_number', eq: 'WYK884213', why: 'title number' },
      { key: 'contract.seller.', prefix: true, has: /hargreaves/i, why: 'seller' },
      { key: 'contract.buyer.', prefix: true, has: /whitfield/i, why: 'buyer' },
      { key: 'contract.chattels_price_pennies', num: 250_000, why: 'contents £2,500' },
      { key: 'contract.incorporated_conditions', has: /fifth|5th/i, why: 'SCS 5th edition' },
      { key: 'contract.special_condition.', prefix: true, has: /indemnity/i, page: 2, why: 'the indemnity special condition, on page 2' },
    ],
  },
  {
    file: '04-mortgage-offer', role: 'mortgage_offer', extract: 'mortgage',
    facts: [
      { key: 'offer.lender', has: /halden/i, why: 'lender' },
      { key: 'offer.amount_pennies', num: 34_000_000, why: 'loan £340,000' },
      { key: 'offer.expiry_date', eq: '2027-03-02', why: 'offer expiry' },
      { key: 'offer.condition.', prefix: true, has: /building regulation/i, page: 2, why: 'building regs special condition, page 2' },
      { key: 'offer.condition.', prefix: true, has: /let/i, why: 'no letting without consent' },
    ],
  },
  {
    file: '05-con29', role: 'search', searchType: 'CON29', extract: 'search',
    facts: [
      { key: 'search.address', has: /14 oak street/i, why: 'property searched' },
      { key: 'search.flag:', prefix: true, has: /enforcement/i, page: 2, why: 'the enforcement notice, page 2' },
    ],
  },
  {
    file: '06-ta6', role: 'property_forms', extract: 'property_forms',
    facts: [
      { key: 'forms.disputes', has: /wall/i, why: 'the dispute about the front wall' },
      { key: 'forms.notices', has: /enforcement|notice/i, why: 'the enforcement notice' },
      { key: 'forms.alterations', has: /extension/i, why: 'the rear extension' },
      { key: 'forms.alterations_consented', not: 'yes', why: 'the completion certificate is not known: consents are not all held' },
      { key: 'forms.flooded', eq: 'no', why: 'no flooding' },
      { key: 'forms.japanese_knotweed', eq: 'no', why: 'no knotweed' },
      { key: 'forms.epc_rating', eq: 'C', why: 'EPC C' },
    ],
  },
  {
    file: '07-management-pack', role: 'management_pack', extract: 'management_pack',
    facts: [
      { key: 'pack.service_charge_pennies_pa', num: 184_000, why: 'service charge £1,840' },
      { key: 'pack.ground_rent_pennies_pa', num: 25_000, why: 'ground rent £250' },
      { key: 'pack.arrears_pennies', num: 42_000, why: 'arrears £420' },
      { key: 'pack.reserve_fund_pennies', num: 1_860_000, why: 'reserve fund £18,600' },
      { key: 'pack.major_works_planned', eq: 'yes', why: 'roof replacement planned' },
      { key: 'pack.section_20_notice', eq: 'yes', why: 'section 20 notice served' },
      { key: 'pack.insurer', has: /aviva/i, why: 'insurer' },
      { key: 'pack.fee.notice_of_assignment_pennies', num: 9_000, why: 'notice of assignment £90' },
    ],
  },
  {
    file: '08-indemnity', role: 'supporting_document', extract: 'supporting_document',
    facts: [
      { key: 'support.issued_by', has: /stewart title/i, why: 'insurer' },
      { key: 'support.reference', eq: 'ST-448812', why: 'policy number' },
      { key: 'support.limit_pennies', num: 42_500_000, why: 'limit £425,000' },
      { key: 'support.benefit_passes', eq: 'yes', why: 'passes to successors and mortgagees' },
      { key: 'support.covers', has: /extension|building regulation/i, why: 'what it covers' },
    ],
  },
  {
    file: '09-survey', role: 'survey', extract: 'survey',
    facts: [
      { key: 'survey.type', eq: 'level3', why: 'Level 3' },
      { key: 'survey.market_value_pennies', num: 42_000_000, why: 'market value £420,000' },
      { key: 'survey.reinstatement_cost_pennies', num: 28_500_000, why: 'reinstatement £285,000' },
      { key: 'survey.recommendation.', prefix: true, has: /damp/i, why: 'damp investigation' },
      { key: 'survey.recommendation.', prefix: true, has: /roof/i, why: 'roof repair' },
      { key: 'survey.legal.', prefix: true, has: /building regulation|completion certificate/i, why: 'the building regulations point for the lawyer' },
    ],
  },
  {
    file: '10-id-check', role: 'id_check', extract: 'id_check',
    facts: [
      { key: 'id.provider', has: /thirdfort/i, why: 'provider' },
      { key: 'id.outcome', has: /pass|clear/i, why: 'result' },
      { key: 'id.subject.', prefix: true, has: /whitfield/i, why: 'who was checked' },
    ],
  },
];

export const QUESTIONS: EvalQuestion[] = [
  { q: 'What is the ground rent and does it go up?', file: '02-lease', answer: [/250/, /doubl/i], why: 'lease rent clause' },
  { q: 'Is there an enforcement notice on the property?', file: '05-con29', page: 2, answer: [/wall/i], why: 'CON29 3.9' },
  { q: 'Who repairs the roof of the building at Wharf Road?', file: '02-lease', page: 3, answer: [/management company/i], why: 'lease 4.1' },
  { q: 'How much is the deposit?', file: '03-contract', page: 1, answer: [/42,500/], why: 'contract front page' },
  { q: 'When does the mortgage offer expire?', file: '04-mortgage-offer', page: 1, answer: [/2 march 2027|2027-03-02|02\/03\/2027/i], why: 'offer validity' },
  { q: 'Who insures the building at Wharf Road and when does the policy renew?', file: '07-management-pack', page: 2, answer: [/aviva/i, /24 june 2027|2027-06-24/i], why: 'LPE1 insurance' },
  { q: 'Can the tenant of the flat keep a dog?', file: '02-lease', page: 2, answer: [/consent/i], why: 'lease 3.5' },
  { q: 'What did the surveyor say about damp?', file: '09-survey', answer: [/damp/i, /specialist|investigat/i], why: 'survey E4 and R2' },
  { q: 'Is there a building regulations completion certificate for the rear extension?', file: null, answer: [/indemnity|no |not /i], why: 'search, TA6, survey and the indemnity all speak to it' },
  { q: 'Does the property have a swimming pool?', file: null, answer: [], why: 'nothing on the file: the answer must say the file does not say' },
];
