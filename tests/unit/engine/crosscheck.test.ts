import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crossCheck, normName, parsePennies, type RegisterRow } from '../../../lib/server/engine/crosscheck';
import { flattenFacts } from '../../../lib/server/engine/review';
import type { ContractFacts } from '../../../lib/server/engine/types';

const record = { propertyAddress: '7 Mill Lane, Henley-on-Thames, RG9 2BH', purchasePricePennies: 38_500_000, buyerNames: ['Tomasz Nowak', 'Ewa Nowak'], sellerNames: ['The Vendors'], lender: 'Mock Building Society', completionDate: null };
const row = (documentLabel: string, key: string, value: string, page: number | null = 1): RegisterRow => ({ documentId: documentLabel, documentLabel, key, value, page });

test('cross-checks agree when the same fact reads the same across documents, forgiving punctuation, case and titles', () => {
  const rows = [
    row('contract.pdf', 'contract.address', '7 MILL LANE, HENLEY ON THAMES, RG9 2BH'),
    row('offer.pdf', 'offer.address', '7 Mill Lane Henley-on-Thames RG92BH'),
    row('contract.pdf', 'contract.price_pennies', '38500000'),
    row('contract.pdf', 'contract.buyer.0', 'Mr T Nowak'),
    row('contract.pdf', 'contract.buyer.1', 'Mrs Ewa Nowak'),
    row('offer.pdf', 'offer.borrower.0', 'TOMASZ NOWAK'),
    row('offer.pdf', 'offer.lender', 'Mock Building Society plc'),
  ];
  const r = crossCheck(record, rows);
  assert.deepEqual(Object.fromEntries(r.map((x) => [x.check, x.status])), { address: 'match', price: 'match', lender: 'match', buyer_names: 'match' });
});

test('a different price, a wrong postcode and a stranger on the contract are mismatches with every source named', () => {
  const rows = [
    row('contract.pdf', 'contract.address', '7 Mill Lane, Henley-on-Thames, RG9 2BX', 1),
    row('contract.pdf', 'contract.price_pennies', '38000000', 1),
    row('contract.pdf', 'contract.buyer.0', 'Tomasz Nowak'),
    row('contract.pdf', 'contract.buyer.1', 'Anna Kowalska'),
    row('title.pdf', 'title.number', 'ON123456', 1),
    row('contract.pdf', 'contract.title_number', 'ON 123 456', 2),
  ];
  const byCheck = Object.fromEntries(crossCheck(record, rows).map((x) => [x.check, x]));
  assert.equal(byCheck.address.status, 'mismatch');
  assert.match(byCheck.address.message, /Case record/);
  assert.equal(byCheck.price.status, 'mismatch');
  assert.match(byCheck.price.message, /£385,000.*£380,000|£380,000.*£385,000/);
  assert.equal(byCheck.buyer_names.status, 'mismatch');
  assert.match(byCheck.buyer_names.message, /Anna Kowalska/);
  assert.equal(byCheck.title_number.status, 'match', 'spacing in a title number is not a disagreement');
});

test('a fact on one source only is not a verdict; helpers parse money and names', () => {
  assert.deepEqual(crossCheck(record, [row('contract.pdf', 'contract.title_number', 'ON1')]).map((x) => x.check), ['buyer_names'].filter(() => false).concat(['address'].filter(() => false)));
  assert.equal(parsePennies('£385,000'), 38_500_000);
  assert.equal(parsePennies('385000.50'), 38_500_050);
  assert.deepEqual(normName('Dr. Ewa Nowak').tokens, ['ewa', 'nowak']);
});

test('a contract flattens to the register keys the cross-checks read', () => {
  const facts: ContractFacts = { sellers: ['The Vendors'], buyers: ['Tomasz Nowak', 'Ewa Nowak'], propertyAddress: '7 Mill Lane', titleNumber: 'ON123456', pricePennies: 38_500_000, depositPennies: 3_850_000, depositHolder: 'stakeholder', completionDate: '2026-12-17', chattelsPricePennies: null, vat: null, incorporatedConditions: 'SCS 5th ed', noticeToCompleteDays: 10, fixturesListPresent: true, specialConditions: [{ code: 'SC5', text: 'The seller shall...', locator: { page: 3, quote: 'The seller shall' } }], indemnities: [], flags: [], confidence: 0.9 };
  const keys = flattenFacts('contract', facts).map((f) => f.key);
  for (const k of ['contract.seller.0', 'contract.buyer.1', 'contract.address', 'contract.title_number', 'contract.price_pennies', 'contract.completion_date', 'contract.special_condition.SC5']) assert.ok(keys.includes(k), k);
});
