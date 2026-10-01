/**
 * People events (people.ts): a death, a loss of capacity or a bankruptcy changes who can instruct, sign and be paid;
 * a report to the NCA holds money and exchange without saying why; a sanctions match is a hard stop no gate change
 * releases; nothing is sent to a client who has died; on a sale our client's ID is checked against the proprietor.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, type Command } from '../../../lib/server/engine/machine';
import { applyEvent } from '../../../lib/server/engine/projection';
import { initialState, type EngineEvent, type MatterState } from '../../../lib/server/engine/types';
import { amlHoldActive, clientMessagesStopped } from '../../../lib/server/engine/people';
import { crossCheck } from '../../../lib/server/engine/crosscheck';
import { harness, TENANT, MATTER, USER } from './helpers';

const NOW = new Date('2026-10-01T10:00:00Z');
let seq = 0;
const fold = (s: MatterState, cmd: Record<string, unknown>, now = NOW): MatterState => {
  const { events } = decide(s, { actor: USER, ...cmd } as unknown as Command, { now });
  return events.map((e) => ({ ...e, id: `e${++seq}`, seq, tenantId: TENANT, matterId: MATTER, createdAt: now.toISOString(), sourceDocumentId: e.sourceDocumentId ?? null } as unknown as EngineEvent)).reduce(applyEvent, s);
};
const purchase = (over: Partial<MatterState> = {}): MatterState => ({ ...initialState(TENANT, MATTER), enrolled: true, transactionType: 'freehold_purchase', stage: 'pre_exchange', hasLender: true, partyNames: ['Asha Patel'], ...over });
const open = (s: MatterState) => Object.values(s.issues).filter((i) => i.status === 'open').map((i) => `${i.kind}:${i.gate}:${i.severity}`);

test('our sole client dies before exchange: the retainer ends, the lender is told, and nothing more is sent to them', () => {
  const s = fold(purchase(), { type: 'record_party_event', event: 'died', party: 'Asha Patel', note: 'Her son called' });
  assert.deepEqual(open(s), ['probate_issue:exchange:critical', 'lender_approval:exchange:critical']);
  assert.match(Object.values(s.issues)[0].detail ?? '', /retainer ended/);
  assert.ok(clientMessagesStopped(s));
});

test('one of two buyers dies after exchange: the survivor is asked, completion is held, and messages still go to the survivor', () => {
  const s = fold(purchase({ partyNames: ['Asha Patel', 'Ben Carter'], stage: 'pre_completion', exchange: { ...initialState(TENANT, MATTER).exchange, exchangedAt: '2026-09-20T10:00:00Z', completionDate: '2026-10-20' } }), { type: 'record_party_event', event: 'died', party: 'Ben Carter' });
  assert.deepEqual(open(s), ['client_change:completion:critical', 'lender_approval:completion:critical']);
  assert.equal(clientMessagesStopped(s), null);
});

test('loss of capacity with and without a power of attorney; a seller\'s bankruptcy makes the trustee the seller', () => {
  const lpa = fold(purchase({ hasLender: false }), { type: 'record_party_event', event: 'capacity_lost', party: 'Asha Patel', hasAttorney: true });
  assert.match(Object.values(lpa.issues)[0].title, /instructions from the attorney/);
  const none = fold(purchase({ hasLender: false }), { type: 'record_party_event', event: 'capacity_lost', party: 'Asha Patel', hasAttorney: false });
  assert.match(Object.values(none.issues)[0].detail ?? '', /Court of Protection/);
  const sale = fold(purchase({ transactionType: 'freehold_sale', hasLender: false }), { type: 'record_party_event', event: 'bankrupt', party: 'Asha Patel' });
  assert.match(Object.values(sale.issues)[0].detail ?? '', /trustee in bankruptcy, who is now the seller/);
});

test('a report to the NCA holds money and exchange for seven working days, without saying why; consent lifts it, refusal starts the moratorium', () => {
  let s = fold(purchase(), { type: 'sar_made' });
  assert.ok(amlHoldActive(s, NOW));
  assert.throws(() => decide(s, { type: 'contracts_exchanged', actor: USER, completionDate: '2026-10-20' } as never, { now: NOW }), /on hold\. Speak to the MLRO/);
  assert.ok(!amlHoldActive(s, new Date('2026-10-13T10:00:00Z')), 'no reply in seven working days: consent is deemed');
  const refused = fold(s, { type: 'daml_response', decision: 'refused' });
  assert.ok(amlHoldActive(refused, new Date('2026-10-20T10:00:00Z')), 'the 31-day moratorium');
  s = fold(s, { type: 'daml_response', decision: 'granted' });
  assert.ok(!amlHoldActive(s, NOW));
});

test('a sanctions match is a hard stop: no money, no exchange; it cannot be released by changing what it holds', () => {
  let s = purchase({ stage: 'instruction', idCheck: { ...initialState(TENANT, MATTER).idCheck, status: 'requested' } });
  s = fold(s, { type: 'id_check_result', documentId: 'd1', facts: { provider: 'x', outcome: 'refer', confidence: 0.99, flags: [{ code: 'SANCTIONS_MATCH', severity: 'high', description: 'Name matches the consolidated list' }] } });
  const hit = Object.values(s.issues).find((i) => i.title.startsWith('Sanctions match'))!;
  assert.ok(hit);
  assert.throws(() => decide({ ...s, stage: 'pre_exchange' }, { type: 'payment_authorised', actor: USER, payeeKind: 'seller_solicitor', bankDetailsId: 'b', purpose: 'deposit' } as never, { now: NOW }), /sanctions match is not cleared/);
  assert.throws(() => decide(s, { type: 'update_issue', actor: USER, issueId: hit.id, status: 'open', gate: 'none', note: 'fine' } as never, { now: NOW }), /hard stop/);
});

test('on a sale our client\'s ID is compared with the registered proprietor, not with the buyers', () => {
  const rows = [
    { documentId: 'id', documentLabel: 'ID check', key: 'id.subject.0', value: 'Jane Smith', page: null },
    { documentId: 'title', documentLabel: 'Register', key: 'title.proprietor.0', value: 'John Brown', page: null },
  ];
  const r = crossCheck({ propertyAddress: null, purchasePricePennies: null, buyerNames: ['Pat Buyer'], sellerNames: ['Jane Smith'], lender: null, completionDate: null, side: 'seller' }, rows);
  const sellers = r.find((x) => x.check === 'seller_names')!;
  assert.equal(sellers.status, 'mismatch', 'the proprietor is not our client');
  assert.ok(!r.find((x) => x.check === 'buyer_names' && x.status === 'mismatch'), 'our client is not compared with the buyers');
});

test('the service sends nothing to a client who has died', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: false, requireProofOfFunds: false, requireExchangeAuthority: false, partyNames: ['Asha Patel'] } as never);
  await h.svc.run(TENANT, MATTER, { type: 'record_party_event', actor: USER, event: 'died', party: 'Asha Patel' } as never);
  const before = h.ports.clientComms.sent.length;
  // The send is refused at the port; the case records it as not sent, it does not throw at the person.
  await h.svc.requestIdCheck(TENANT, MATTER, USER).catch(() => null);
  assert.equal(h.ports.clientComms.sent.length, before, 'nothing reached the client');
});
