import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCompletionStatement, daysBetween, parsePeriod } from '../../../lib/server/engine/completion-statement';
import { checkDraft } from '../../../lib/server/engine/draft-check';
import { initialState } from '../../../lib/server/engine/types';
import type { RegisterFact } from '../../../lib/server/engine/draft-check';
import { harness, TENANT, MATTER, USER, idClear, searchClear, titleClear } from './helpers';

const f = (id: string, key: string, value: string, label = 'Draft contract.pdf', page = 2): RegisterFact => ({ id, documentId: `doc-${label}`, documentLabel: label, key, value, page, quote: `${key} ${value}` });
const record = { propertyAddress: '7 Mill Lane, Henley-on-Thames, RG9 2BH', purchasePricePennies: 38_500_000, buyerNames: ['Tomasz Nowak'], sellerNames: ['Anna Kowalska'] };

test('periods and day counts read the way packs write them', () => {
  assert.deepEqual(parsePeriod('1 April 2026 to 31 March 2027'), { from: '2026-04-01', to: '2027-03-31' });
  assert.deepEqual(parsePeriod('01/04/2026 - 31/03/2027'), { from: '2026-04-01', to: '2027-03-31' });
  assert.equal(parsePeriod('the year'), null);
  assert.equal(daysBetween('2026-04-01', '2027-03-31'), 365);
  assert.equal(daysBetween('2026-12-04', '2027-03-31'), 118);
});

test('buyer statement: price less deposit less advance, apportionments computed from the pack, fees left to confirm, every figure cited', () => {
  const s = initialState(TENANT, MATTER);
  s.enrolled = true; s.hasLender = true; s.transactionType = 'leasehold_purchase';
  s.exchange.completionDate = '2026-12-04';
  s.mortgage.facts = { lender: 'Mock BS', conditions: [], confidence: 0.9 } as never;
  const register = [
    f('p', 'contract.price_pennies', '38500000'),
    f('d', 'contract.deposit_pennies', '3850000'),
    f('a', 'offer.amount_pennies', '30000000', 'Offer.pdf', 1),
    f('sc', 'pack.service_charge_pennies_pa', '240000', 'LPE1.pdf', 1),
    f('scp', 'pack.service_charge_period', '1 April 2026 to 31 March 2027', 'LPE1.pdf', 1),
    f('gr', 'lease.ground_rent_pennies_pa', '25000', 'Lease.pdf', 2),
  ];
  const st = buildCompletionStatement({ state: s, side: 'buyer', register, record });
  const by = Object.fromEntries(st.lines.map((l) => [l.label.replace(/ \(.*$/, ''), l]));
  assert.equal(by['Purchase price'].pennies, 38_500_000);
  assert.equal(by['Less deposit paid on exchange'].pennies, 3_850_000);
  assert.equal(by['Less mortgage advance'].pennies, 30_000_000);
  assert.equal(by['Apportionment of service charge'].pennies, Math.round((240_000 * 118) / 365));
  assert.equal(by['Apportionment of ground rent'].pennies, Math.round((25_000 * 118) / 365));
  assert.equal(by['Stamp Duty Land Tax'].pennies, 925_000, '£385,000 at standard rates: 2% of £125,000 + 5% of £135,000');
  assert.equal(st.balancePennies, 38_500_000 - 3_850_000 - 30_000_000 + 925_000 + Math.round((240_000 * 118) / 365) + Math.round((25_000 * 118) / 365));
  assert.match(st.text, /Purchase price\s+£385,000\.00/);
  assert.match(st.text, /Less mortgage advance \(Mock BS\)\s+\(£300,000\.00\)/);
  assert.match(st.text, /Stamp Duty Land Tax \(estimate[^)]*\)\s+£9,250\.00/);
  assert.match(st.text, /BALANCE REQUIRED FROM YOU/);
  assert.deepEqual(st.toConfirm.filter((x) => !x.startsWith('SDLT:')), []);
  assert.ok(st.toConfirm.some((x) => /^SDLT: £9,250\.00 is the estimate on the standard basis/.test(x)));
  // Checked like any draft: the read figures cite, the computed ones are allowed, nothing is struck.
  const c = checkDraft(st.text, register, { allowed: [...st.allowed, record.propertyAddress, '2026-12-04', ...record.buyerNames] });
  assert.equal(c.summary.struck, 0, `struck: ${c.notFromFile.map((n) => n.text).join(', ')}`);
  assert.ok(c.cited.some((x) => x.id === 'p') && c.cited.some((x) => x.id === 'a'));
});

test('seller statement: price less redemption; the agent and the fees are to confirm; a missing period leaves the apportionment to confirm', () => {
  const s = initialState(TENANT, MATTER);
  s.enrolled = true; s.transactionType = 'leasehold_sale';
  s.exchange.completionDate = '2026-12-04';
  s.redemption = { ...s.redemption, status: 'received', lender: 'Big Bank', redemptionPennies: 12_345_678, validUntil: '2026-12-10' };
  const st = buildCompletionStatement({ state: s, side: 'seller', register: [f('p', 'contract.price_pennies', '38500000'), f('sc', 'pack.service_charge_pennies_pa', '240000', 'LPE1.pdf', 1)], record });
  assert.equal(st.balancePennies, 38_500_000 - 12_345_678);
  assert.ok(st.toConfirm.some((t) => t.startsWith("Estate agent's commission")));
  assert.ok(st.toConfirm.some((t) => t.startsWith('Apportionment of service charge')));
  assert.match(st.text, /BALANCE DUE TO YOU/);
  assert.match(st.text, /figure valid until 2026-12-10/);
});

test('service: the statement is filed as a checked draft the completion sheet can pick', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, requireProofOfFunds: false, requireExchangeAuthority: false, hasLender: false, requiredSearches: ['CON29'], targetExchangeDate: '2026-11-20', targetCompletionDate: '2026-12-04' });
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  await h.svc.idCheckResultReceived(TENANT, MATTER, h.doc(idClear()));
  await h.svc.searchReturned(TENANT, MATTER, 'CON29', h.doc(searchClear('CON29')));
  await h.svc.titleReceived(TENANT, MATTER, h.doc(titleClear()));
  h.ports.documents.register = { facts: [f('p', 'contract.price_pennies', '38500000'), f('d', 'contract.deposit_pennies', '3850000')], allowed: ['7 Mill Lane, RG9 2BH'] };
  const r = await h.svc.draftCompletionStatement(TENANT, MATTER);
  const doc = h.ports.documents.all().find((d) => d.id === r.documentId)!;
  assert.equal(doc.docType, 'COMPLETION_STATEMENT');
  const content = (doc.extractedFacts as { content: string }).content;
  assert.match(content, /Less deposit paid on exchange\s+\(£38,500\.00\) \[\d\]/);
  assert.match(content, /SOURCES\n1\. Draft contract\.pdf p\.2/);
  assert.ok(h.ports.documents.draftChecks.get(doc.id));
  assert.match(r.warning ?? '', /Completion statement drafted under Documents/);
});
