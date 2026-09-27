import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LeaseExtractionSchema, ManagementPackExtractionSchema, toLeaseFacts, toManagementPackFacts } from '../../../lib/server/engine/extraction';
import { evaluateLease, leaseFlags } from '../../../lib/server/engine/rules';
import { flattenFacts } from '../../../lib/server/engine/review';
import { crossCheck, type RegisterRow } from '../../../lib/server/engine/crosscheck';
import { pendingDecisions } from '../../../lib/server/engine/types';
import type { LeaseFacts, ManagementPackFacts } from '../../../lib/server/engine/types';
import { harness, firstDecision, resolve, TENANT, MATTER, USER, idClear, searchClear, titleLeasehold } from './helpers';

const loc = (page: number, quote: string) => ({ page, section: '', quote });

const leaseOut = () => LeaseExtractionSchema.parse({
  pages: [{ page: 1, verdict: 'facts' }, { page: 2, verdict: 'facts' }, { page: 3, verdict: 'nothing' }],
  demise: 'Flat 3, second floor, 7 Mill Lane, with the balcony',
  landlord: 'Mill Lane Freeholds Limited',
  managementCompany: '',
  termYears: 125,
  termStartDate: '1998-01-01',
  leaseDate: '1998-03-14',
  unexpiredYears: 96,
  groundRentPenniesPa: 25_000,
  groundRentReview: 'The rent doubles on every 10th anniversary of the term',
  serviceChargeProportion: '12.5%',
  repairs: 'The lessor repairs the structure and roof; the lessee repairs the interior and windows',
  alienation: 'Not to assign without the prior written consent of the lessor, such consent not to be unreasonably withheld',
  alterations: 'No structural alterations',
  permittedUse: 'A single private dwelling',
  insurance: 'The lessor insures; the lessee pays a fair proportion of the premium',
  landlordNotices: 'Notice of assignment and of any charge within one month, fee £75 plus VAT',
  forfeiture: 'Re-entry on 21 days\' arrears or breach of covenant',
  clauses: [
    { code: '3.1', topic: 'rent', text: 'The rent doubles on every 10th anniversary of the term', locator: loc(2, 'doubles on every 10th anniversary'), confidence: 0.95 },
    { code: '4.7', topic: 'alienation', text: 'Not to assign without the prior written consent of the lessor', locator: loc(2, 'Not to assign without the prior written consent'), confidence: 0.9 },
  ],
  flags: [{ code: 'ground rent doubling', severity: 'low', description: 'The ground rent doubles every ten years.', locator: loc(2, 'doubles on every 10th anniversary'), confidence: 0.95 }],
  scanQuality: 'good',
  confidence: 0.93,
});

const packOut = () => ManagementPackExtractionSchema.parse({
  pages: [{ page: 1, verdict: 'facts' }, { page: 2, verdict: 'facts' }],
  bsaRelevantBuilding: 'not_stated', bsaLeaseholderDeedOfCertificate: 'not_stated', bsaLandlordCertificate: 'not_stated', bsaRemediation: '',
  landlord: 'Mill Lane Freeholds Ltd',
  managingAgent: 'Block Managers Ltd',
  serviceChargePenniesPa: 240_000,
  serviceChargePeriod: '1 April 2026 to 31 March 2027',
  serviceChargeProportion: '12.5%',
  groundRentPenniesPa: 35_000,
  arrearsPennies: 0,
  reserveFundPennies: 1_200_000,
  majorWorksPlanned: true,
  majorWorks: 'Roof renewal 2027, estimated £48,000, this flat 12.5%',
  section20Notice: true,
  buildingsInsuranceInPlace: true,
  insurer: 'Aviva',
  insuredSumPennies: 320_000_000,
  insuranceExpiryDate: '2027-02-28',
  feeNoticeOfAssignmentPennies: 9_000,
  feeNoticeOfChargePennies: 9_000,
  feeDeedOfCovenantPennies: 15_000,
  feeCertificateOfCompliancePennies: 0,
  feesOther: '',
  consentsRequired: 'Deed of covenant with the management company',
  disputes: '',
  accountsProvided: 'Years ending March 2024 and 2025; budget 2026/27',
  entries: [{ code: '3.4', text: 'Roof renewal planned for 2027 at an estimated £48,000', locator: loc(2, 'Roof renewal planned for 2027'), confidence: 0.9 }],
  flags: [{ code: 'MAJOR_WORKS_PLANNED', severity: 'medium', description: 'Roof renewal planned for 2027.', locator: loc(2, 'Roof renewal planned for 2027'), confidence: 0.9 }],
  scanQuality: 'good',
  confidence: 0.9,
});

test('the lease and the pack are read into typed facts; empties become null and flags keep the taxonomy floor', () => {
  const l = toLeaseFacts(leaseOut());
  assert.equal(l.managementCompany, null);
  assert.equal(l.unexpiredYears, 96);
  assert.equal(l.clauses?.length, 2);
  assert.equal(l.flags?.[0].code, 'GROUND_RENT_DOUBLING');
  assert.equal(l.flags?.[0].severity, 'high', 'model said low; the taxonomy floor is high');
  assert.equal(l.locator?.page, 2, 'the rent clause locates the lease facts');
  const p = toManagementPackFacts(packOut());
  assert.equal(p.disputes, null);
  assert.deepEqual(p.fees, { noticeOfAssignmentPennies: 9_000, noticeOfChargePennies: 9_000, deedOfCovenantPennies: 15_000, certificateOfCompliancePennies: null, other: null });
  assert.equal(p.section20Notice, true);
  assert.equal(p.entries?.length, 1);
});

test('lease rules: a doubling rent and an absolute bar on assignment flag; a plain lease clears', () => {
  const l = toLeaseFacts(leaseOut());
  const codes = leaseFlags(l).map((f) => f.code);
  assert.ok(codes.includes('GROUND_RENT_DOUBLING'));
  assert.ok(!codes.includes('LEASE_ALIENATION_ABSOLUTE'), 'qualified consent is not an absolute bar');
  assert.ok(!codes.includes('SHORT_LEASE'));
  const bar = leaseFlags({ ...l, groundRentReview: 'fixed', flags: [], alienation: 'Not to assign or underlet the whole or any part' });
  assert.ok(bar.map((f) => f.code).includes('LEASE_ALIENATION_ABSOLUTE'));
  assert.equal(evaluateLease({ unexpiredYears: 96, groundRentPenniesPa: 25_000, groundRentReview: 'fixed', alienation: 'with consent', flags: [], confidence: 0.9 }).outcome, 'clear');
  assert.equal(evaluateLease({ unexpiredYears: 78, flags: [], confidence: 0.9 }).outcome, 'flag');
});

test('the review tables: lease and pack facts flatten to keyed rows with quoted clauses, and the cross-checks compare them', () => {
  const l = toLeaseFacts(leaseOut());
  const rows = flattenFacts('lease', l);
  const keys = rows.map((r) => r.key);
  assert.ok(keys.includes('lease.ground_rent_pennies_pa') && keys.includes('lease.repairs') && keys.includes('lease.clause.rent.3.1') && keys.includes('lease.flag:GROUND_RENT_DOUBLING'));
  assert.equal(rows.find((r) => r.key === 'lease.clause.alienation.4.7')?.page, 2);
  const p = toManagementPackFacts(packOut());
  const prow = flattenFacts('management_pack', p);
  const pkeys = prow.map((r) => r.key);
  assert.ok(pkeys.includes('pack.fee.deed_of_covenant_pennies') && pkeys.includes('pack.section_20_notice') && pkeys.includes('pack.entry.3.4') && pkeys.includes('pack.insurance_expiry_date'));
  const reg: RegisterRow[] = [
    ...rows.map((r) => ({ documentId: 'lease', documentLabel: 'Lease.pdf', key: r.key, value: r.value, page: r.page })),
    ...prow.map((r) => ({ documentId: 'pack', documentLabel: 'LPE1.pdf', key: r.key, value: r.value, page: r.page })),
  ];
  const checks = crossCheck({ propertyAddress: null, purchasePricePennies: null, buyerNames: [], sellerNames: [], lender: null, completionDate: null }, reg);
  const byId = Object.fromEntries(checks.map((c) => [c.check, c]));
  assert.equal(byId.ground_rent.status, 'mismatch');
  assert.match(byId.ground_rent.message, /£250 a year \(Lease\.pdf\) vs £350 a year \(LPE1\.pdf\)/);
  assert.equal(byId.landlord.status, 'match', 'Limited vs Ltd is the same landlord');
});

test('service: the lease read raises the title decision, stays with the official copy read later, and the pack read fills the decision', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, transactionType: 'leasehold_purchase', hasLender: false, requiredSearches: ['CON29'] });
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  await h.svc.idCheckResultReceived(TENANT, MATTER, h.doc(idClear()));
  await h.svc.searchReturned(TENANT, MATTER, 'CON29', h.doc(searchClear('CON29')));
  const lease: LeaseFacts = toLeaseFacts(leaseOut());
  const leaseDoc = h.doc(lease);
  const r = await h.svc.leaseReceived(TENANT, MATTER, leaseDoc);
  assert.ok(r.events.some((e) => e.type === 'lease_extracted'));
  let s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.title.status, 'flagged');
  assert.equal(s.title.leaseDocumentId, leaseDoc);
  const d = firstDecision(s, 'title');
  assert.equal(d.sourceDocumentId, leaseDoc);
  assert.match(d.summary, /doubl/i);
  await resolve(h, d.eventId, 'approve', USER, 'Deed of variation to be obtained; lender content');
  // The official copy arrives afterwards: the rules see the lease with it.
  await h.svc.titleReceived(TENANT, MATTER, h.doc(titleLeasehold()));
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.title.facts?.lease?.unexpiredYears, 96, 'the lease facts ride with the title facts');
  assert.equal(s.title.lease?.groundRentPenniesPa, 25_000);
  // The management pack: read by the extractor, the decision carries the fees and the insurance.
  await h.svc.run(TENANT, MATTER, { type: 'management_pack_requested', actor: USER, from: 'Block Managers Ltd' });
  const pack: ManagementPackFacts = toManagementPackFacts(packOut());
  await h.svc.managementPackReceived(TENANT, MATTER, h.doc(pack));
  s = await h.svc.getState(TENANT, MATTER);
  const mp = pendingDecisions(s).find((x) => x.kind === 'management_pack')!;
  assert.ok(mp, 'a management-pack decision is pending');
  assert.match(mp.summary, /Fees on sale: notice of assignment £90/);
  assert.match(mp.summary, /Buildings insurance: in place · Aviva/);
  assert.match(mp.summary, /section 20 consultation under way/);
  assert.equal(s.managementPack.facts?.managingAgent, 'Block Managers Ltd');
});

test('a lease on a freehold matter is skipped by the router, not read', async () => {
  const { routeClassification } = await import('../../../lib/server/engine/ingest');
  const { initialState } = await import('../../../lib/server/engine/types');
  const st = { ...initialState(TENANT, MATTER), enrolled: true, transactionType: 'freehold_purchase' as const };
  const a = routeClassification(st, { role: 'lease', searchType: null, enquiryReferences: [], titleNumber: null, lender: null, confidence: 0.9, reason: 'a lease' });
  assert.equal(a.kind, 'skip');
});
