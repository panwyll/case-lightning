/**
 * Readings become typed issues (findings.ts): the title, lease, search and contract findings that change what the file
 * needs each raise an issue of their own kind with its gate, once per case.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contractFindings, leaseFindings, searchFindings, titleFindings } from '../../../lib/server/engine/findings';
import { leaseFlags } from '../../../lib/server/engine/rules';
import { decide, type Command } from '../../../lib/server/engine/machine';
import { applyEvent } from '../../../lib/server/engine/projection';
import { initialState, type EngineEvent, type MatterState, type TitleFacts } from '../../../lib/server/engine/types';
import { TENANT, MATTER, USER } from './helpers';

const buyer = { side: 'buyer' as const, hasLender: true };
const title = (over: Partial<TitleFacts>): TitleFacts => ({ titleNumber: 'AB123', tenure: 'freehold', restrictions: [], charges: [], covenants: [], confidence: 0.95, ...over });

test('the register: a consent restriction, a non-lender charge and home rights each raise their own kind; a lender\'s charge does not', () => {
  const f = titleFindings(title({
    restrictions: [{ code: 'R1', register: 'B', text: 'No disposition of the registered estate is to be registered without a certificate signed by Oak Court Management Company Limited that the provisions of clause 5 have been complied with.' }],
    charges: [
      { code: 'C1', register: 'C', text: 'Registered charge dated 1 May 2019 in favour of Nationwide Building Society.' },
      { code: 'C2', register: 'C', text: 'Interim charging order in favour of Acme Debt Recovery made by the County Court.' },
      { code: 'C3', register: 'C', text: 'Notice of home rights under the Family Law Act 1996 registered by Jane Smith.' },
    ],
  }), buyer);
  assert.deepEqual(f.map((x) => `${x.kind}:${x.severity}`), ['title_restriction:warning', 'title_defect:critical', 'title_defect:critical']);
  assert.match(f[1].title, /charging order/);
  assert.match(f[2].detail, /HR4/);
});

test('Form A bites only when our client sells alone', () => {
  const formA = title({ restrictions: [{ code: 'A', register: 'B', text: 'No disposition by a sole proprietor of the registered estate (except a trust corporation) under which capital money arises is to be registered unless authorised by an order of the court.' }] });
  assert.equal(titleFindings(formA, { side: 'seller', hasLender: false, clients: 1 })[0]?.title, 'Form A restriction: a second trustee is needed');
  assert.equal(titleFindings(formA, { side: 'seller', hasLender: false, clients: 2 }).length, 0);
});

test('a covenant against alterations, where the seller says works were done: indemnity is decided before anyone approaches the covenantee', () => {
  const t = title({ covenants: [{ code: 'K1', register: 'C', text: 'Not to erect any building or make any alteration without the prior written consent of the Vendor.' }] });
  assert.equal(titleFindings(t, buyer).length, 0, 'no works, nothing to raise');
  const [f] = titleFindings(t, { ...buyer, alterations: 'Rear extension 2018' });
  assert.equal(f.kind, 'restrictive_covenant');
  assert.match(f.detail, /BEFORE anyone approaches the covenantee/);
});

test('the lease: below 80 years is critical, a doubling rent and an absolute bar on assignment each have their kind', () => {
  const l = { unexpiredYears: 78, groundRentPenniesPa: 30_000, groundRentReview: 'doubling every 25 years', alienation: 'Not to assign the whole or part of the premises' };
  const f = leaseFindings(leaseFlags(l), l, buyer);
  assert.deepEqual(f.map((x) => `${x.kind}:${x.severity}`), ['short_lease:critical', 'ground_rent_issue:warning', 'lease_defect:critical']);
});

test('a search: enforcement and flood risk raise issues; a low entry stays on the review; a sale orders no searches', () => {
  const facts = { searchType: 'CON29' as const, confidence: 0.9, summaryFields: {}, flags: [
    { code: 'PLANNING_ENFORCEMENT', severity: 'high' as const, description: 'Enforcement notice 2024 re: the rear extension' },
    { code: 'FLOOD_RISK_HIGH', severity: 'high' as const, description: 'High risk of surface water flooding' },
    { code: 'CONSERVATION_AREA', severity: 'low' as const, description: 'In a conservation area' },
  ] };
  const f = searchFindings(facts, buyer);
  assert.deepEqual(f.map((x) => x.kind), ['planning_permission_missing', 'environmental_risk']);
  assert.equal(searchFindings(facts, { side: 'seller', hasLender: false }).length, 0);
});

test('the contract: a 5% deposit, a deposit held as agent, a shortened notice to complete and compensation excluded', () => {
  const f = contractFindings({ pricePennies: 30_000_000, depositPennies: 1_500_000, depositHolder: 'as agent for the seller', noticeToCompleteDays: 5, specialConditions: [{ code: '7', text: 'Standard condition 7.2 shall not apply.' }] }, buyer);
  assert.deepEqual(f.map((x) => x.code), ['DEPOSIT_BELOW_10', 'DEPOSIT_AS_AGENT', 'NOTICE_TO_COMPLETE_SHORT', 'TERM:LATE_COMPLETION_COMPENSATION_EXCLUDED']);
  assert.match(f[0].title, /5% of the price/);
});

test('in the machine: a finding is raised once per case, and a deposit short of the contract\'s is then checked against it', () => {
  let s: MatterState = { ...initialState(TENANT, MATTER), enrolled: true, transactionType: 'freehold_purchase', stage: 'contract_review', hasLender: false, purchasePricePennies: 30_000_000 };
  let seq = 0;
  const run = (cmd: Record<string, unknown>) => { const { events } = decide(s, { actor: USER, ...cmd } as unknown as Command, { now: new Date('2026-10-01T10:00:00Z') }); s = events.map((e) => ({ ...e, id: `e${++seq}`, seq, tenantId: TENANT, matterId: MATTER, createdAt: '2026-10-01T10:00:00Z', sourceDocumentId: e.sourceDocumentId ?? null } as unknown as EngineEvent)).reduce(applyEvent, s); return events; };
  const terms = { pricePennies: 30_000_000, depositPennies: 1_500_000, depositHolder: 'stakeholder', noticeToCompleteDays: 10, specialConditions: [] };
  run({ type: 'raise_contract_review', documentId: 'd1', summary: 'contract', terms });
  const deposit = Object.values(s.issues).filter((i) => i.finding === 'DEPOSIT_BELOW_10');
  assert.equal(deposit.length, 1);
  assert.equal(deposit[0].gate, 'exchange');
  assert.equal(s.deposit.contractPennies, 1_500_000, 'the contract deposit is on the case for the receipt check');
  // The amended draft is read again: the same finding is not raised twice.
  run({ type: 'raise_contract_review', documentId: 'd2', summary: 'amended contract', terms });
  assert.equal(Object.values(s.issues).filter((i) => i.finding === 'DEPOSIT_BELOW_10').length, 1);
});
