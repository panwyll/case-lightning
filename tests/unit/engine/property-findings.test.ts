/**
 * Property: what the register, the forms, the searches, the lease and the pack say, each turned into the right issue;
 * events about the land itself; a second title; unregistered land as a checklist; retentions and indemnities on the
 * statement; a valuation below the price; and every point reaching the report on title.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, type Command } from '../../../lib/server/engine/machine';
import { applyEvent } from '../../../lib/server/engine/projection';
import { titleFindings, searchFindings, leaseFindings, accessGap } from '../../../lib/server/engine/findings';
import { propertyFormsIssues } from '../../../lib/server/engine/property-forms';
import { buildCompletionStatement } from '../../../lib/server/engine/completion-statement';
import { pointsNotInReport } from '../../../lib/server/engine/draft-check';
import { initialState, type EngineEvent, type MatterState, type TitleFacts } from '../../../lib/server/engine/types';
import { TENANT, MATTER, USER } from './helpers';

const NOW = new Date('2026-10-01T10:00:00Z');
let seq = 0;
const fold = (s: MatterState, cmd: Record<string, unknown>): MatterState => {
  const { events } = decide(s, { actor: USER, ...cmd } as unknown as Command, { now: NOW });
  return events.map((e) => ({ ...e, id: `e${++seq}`, seq, tenantId: TENANT, matterId: MATTER, createdAt: NOW.toISOString(), sourceDocumentId: e.sourceDocumentId ?? null } as unknown as EngineEvent)).reduce(applyEvent, s);
};
const base = initialState(TENANT, MATTER);
const purchase = (over: Partial<MatterState> = {}): MatterState => ({ ...base, enrolled: true, transactionType: 'freehold_purchase', stage: 'pre_contract', hasLender: true, partyNames: ['Priya Shah'], purchasePricePennies: 30_000_000, ...over });
const title = (over: Partial<TitleFacts>): TitleFacts => ({ titleNumber: 'AB1', tenure: 'freehold', restrictions: [], charges: [], covenants: [], confidence: 0.95, ...over });
const buyer = { side: 'buyer' as const, hasLender: true };
const open = (s: MatterState) => Object.values(s.issues).filter((i) => i.status === 'open');
const codes = (t: TitleFacts, ctx = buyer) => titleFindings(t, ctx).map((f) => f.code.split(':')[0]);

test('the register read for rights, rentcharges, chancel, minerals, positive covenants, estate charges, pending applications, stale copies', () => {
  const e = (text: string) => ({ code: 'X', text });
  assert.ok(codes(title({ restrictions: [e('No disposition without a certificate that the pre-emption provisions in clause 4 have been complied with')] })).includes('ENCUMBRANCE_RIGHT'));
  assert.ok(codes(title({ propertyEntries: [e('The land is subject to a rentcharge of £5 a year')] })).includes('RENTCHARGE'));
  assert.ok(codes(title({ notices: [e('Agreed notice of chancel repair liability in favour of the PCC of St Mary')] })).includes('CHANCEL_NOTICE'));
  assert.ok(codes(title({ propertyEntries: [e('The mines and minerals are excepted')] })).includes('MINES_MANORIAL'));
  assert.ok(codes(title({ covenants: [e('Covenant to contribute towards the cost of maintaining the shared drive')] })).includes('POSITIVE_COVENANT'));
  assert.ok(codes(title({ covenants: [e('To pay the estate management charge to Meadow Management Company Ltd')] })).includes('ESTATE_CHARGE'));
  assert.ok(codes(title({ pendingApplications: ['Application for a deed of variation lodged 1 Sept 2026'] })).includes('PENDING_LEASE_CHANGE'));
  assert.ok(codes(title({ editionDate: '2026-01-05' })).includes('STALE_COPIES'));
  assert.ok(codes(title({ tenure: 'leasehold', propertyDescription: '12 Oak Road, a semi-detached house' })).includes('LEASEHOLD_HOUSE'));
});

test('shared access on the forms, no right on the register; a right on the register clears it', () => {
  assert.equal(accessGap(title({}), { ...buyer, sharedAccess: true })?.kind, 'missing_easement');
  assert.equal(accessGap(title({ covenants: [{ code: 'A2', text: 'Together with a right of way over the drive edged brown' }] }), { ...buyer, sharedAccess: true }), null);
});

test('the forms: dated works inside or outside enforcement, windows, electrics, gas, knotweed, solar, private water', () => {
  const answers = { alterations: 'Rear extension', alterationsConsented: false, alterationsYear: String(new Date().getUTCFullYear() - 2), windowsReplacedSince2002: true, windowsCertificate: false, electricalWorkSince2005: true, electricalCertificate: false, gasApplianceNoRecord: true, knotweedCategory: 'B', solarPanelsOwned: true, privateWater: true };
  const got = propertyFormsIssues({ forms: ['TA6'], disclosures: [], confidence: 0.9, answers } as never, 'buyer').map((x) => x.flag.code);
  for (const c of ['TA6_PLANNING_DATED', 'TA6_WINDOWS', 'TA6_ELECTRICS', 'TA6_GAS', 'KNOTWEED_AB', 'TA6_SOLAR_OWNED', 'TA6_PRIVATE_WATER']) assert.ok(got.includes(c), c);
  const old = propertyFormsIssues({ forms: ['TA6'], disclosures: [], confidence: 0.9, answers: { alterations: 'Loft conversion', alterationsConsented: false, alterationsYear: '2015' } } as never, 'buyer');
  assert.match(old.find((x) => x.flag.code === 'TA6_PLANNING_DATED')!.title, /past the enforcement period/);
});

test('searches and the lease: a stop notice, a listed building, s.106; a lease with no one repairing the structure', () => {
  const s = searchFindings({ searchType: 'CON29', flags: [{ code: 'STOP_NOTICE', severity: 'high', description: 'Stop notice served 2026' }, { code: 'LISTED_BUILDING', severity: 'medium', description: 'Grade II' }, { code: 'S106_AGREEMENT', severity: 'medium', description: 's106' }], confidence: 0.9 } as never, buyer);
  assert.deepEqual(s.map((f) => f.severity), ['critical', 'warning', 'warning']);
  const l = leaseFindings([], { repairs: 'The tenant shall keep the interior of the flat in good repair', insurance: '' } as never, buyer);
  assert.deepEqual(l.map((f) => f.code), ['LEASE_NO_STRUCTURE_REPAIR', 'LEASE_NO_INSURANCE_COVENANT']);
});

test('the management pack for a buyer: arrears, major works, consents, EWS1', () => {
  const s0 = purchase({ transactionType: 'leasehold_purchase', lenderRequirements: { minUnexpiredYears: null, maxSearchAgeMonths: null, acceptsNonFamilyGift: null, requiresEws1: true, note: null, recordedAt: '' } });
  const s = fold(s0, { type: 'management_pack_received', documentId: 'p1', facts: { arrearsPennies: 120_000, majorWorks: 'Roof 2027', consentsRequired: 'Deed of covenant', buildingSafety: { relevantBuilding: false }, flags: [], confidence: 0.9 } });
  const titles = open(s).map((i) => i.title);
  for (const t of ['Arrears on the account', 'Major works', "Landlord's requirements on assignment", 'EWS1']) assert.ok(titles.some((x) => x.startsWith(t)), t);
});

test('the land itself: a boundary differing from the plan, deeds lost, searches declined', () => {
  assert.equal(open(fold(purchase(), { type: 'record_property_event', event: 'boundary_mismatch', detail: 'The garage is outside the red edging' }))[0].kind, 'boundary_discrepancy');
  assert.equal(open(fold(purchase(), { type: 'record_property_event', event: 'deeds_lost', detail: 'Conveyance of 1962 missing' }))[0].severity, 'critical');
  assert.equal(open(fold(purchase(), { type: 'record_property_event', event: 'searches_declined', detail: 'Cash buyer, wants to save cost' }))[0].kind, 'search_adverse_entry');
});

test('a second title is read beside the first, not over it', () => {
  const s0 = purchase({ title: { ...base.title, status: 'cleared' as never, facts: title({ titleNumber: 'AB1' }) as never } });
  const s = fold(s0, { type: 'title_extracted', documentId: 't2', extractor: 'x', facts: title({ titleNumber: 'AB2', propertyEntries: [{ code: 'A1', text: 'Subject to a rentcharge' }] }) });
  assert.equal((s.title.facts as TitleFacts).titleNumber, 'AB1');
  assert.deepEqual(s.additionalTitles?.map((t) => t.titleNumber), ['AB2']);
  assert.ok(open(s).some((i) => i.title.startsWith('AB2: A rentcharge')));
});

test('a survey valuation below the price raises the valuation issue', () => {
  const s = fold(purchase({ survey: { ...base.survey, status: 'commissioned' as never } }), { type: 'survey_received', documentId: 'sv', surveyType: 'level2', extractor: 'x', facts: { surveyType: 'level2', recommendations: [], marketValuePennies: 29_000_000, confidence: 0.9 } });
  assert.ok(open(s).some((i) => i.kind === 'valuation_issue' && /£10,000.00 below/.test(i.title)));
});

test('the statement: a retention and an indemnity premium on the seller\'s side; arrears paid from the price', () => {
  const sale = { ...purchase(), transactionType: 'leasehold_sale' as const, managementPack: { ...base.managementPack, facts: { arrearsPennies: 50_000 } as never }, issues: {
    I1: { id: 'I1', kind: 'survey_defect', title: 'Roof', status: 'resolved', resolution: 'retention_agreed', costPennies: 500_000, paidBy: 'seller' },
    I2: { id: 'I2', kind: 'building_regs_missing', title: 'Extension', status: 'resolved', resolution: 'indemnity_policy', costPennies: 25_000, paidBy: 'seller' },
  } as never };
  const st = buildCompletionStatement({ state: sale, side: 'seller', register: [{ id: 'p', key: 'contract.price_pennies', value: '30000000' } as never], record: { propertyAddress: null, purchasePricePennies: 30_000_000, buyerNames: [], sellerNames: ['X'] } });
  assert.equal(st.balancePennies, 30_000_000 - 500_000 - 25_000 - 50_000);
});

test('every point found reaches the report, or is listed for the approver', () => {
  const missing = pointsNotInReport('We have checked the title. There is a rentcharge on the land; see below.', ['A rentcharge on the land', 'Chancel repair liability is registered']);
  assert.deepEqual(missing, ['Chancel repair liability is registered']);
});
