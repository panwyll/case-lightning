/**
 * Whatever is recorded shows on the Tasks list: an issue that waits on someone else is ours to chase, never hidden;
 * and a case enrolled without its clients' names takes them from the matter record so "our client" is known.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, type Command } from '../../../lib/server/engine/machine';
import { applyEvent } from '../../../lib/server/engine/projection';
import { matterWork } from '../../../lib/server/engine/work';
import { clientNamesOf } from '../../../lib/server/engine/enrol';
import { initialState, type EngineEvent, type MatterState } from '../../../lib/server/engine/types';
import { TENANT, MATTER, USER } from './helpers';

const NOW = new Date('2026-10-03T10:00:00Z');
let seq = 0;
const fold = (s: MatterState, cmd: Record<string, unknown>): MatterState => {
  const { events } = decide(s, { actor: USER, ...cmd } as unknown as Command, { now: NOW });
  return events.map((e) => ({ ...e, id: `e${++seq}`, seq, tenantId: TENANT, matterId: MATTER, createdAt: NOW.toISOString(), sourceDocumentId: e.sourceDocumentId ?? null } as unknown as EngineEvent)).reduce(applyEvent, s);
};
const base = initialState(TENANT, MATTER);

test('a death recorded on a purchase puts both its issues on the Tasks list at once', () => {
  let s: MatterState = { ...base, enrolled: true, transactionType: 'freehold_purchase', stage: 'pre_exchange', hasLender: true };
  s = fold(s, { type: 'record_client_names', names: ['Asha Patel'] });
  s = fold(s, { type: 'record_party_event', event: 'died', party: 'Asha Patel', note: 'Her son rang' });
  const tasks = matterWork(s, NOW).items.filter((i) => i.ref?.type === 'issue').map((i) => `${i.chip}: ${i.what}`);
  assert.ok(tasks.some((t) => /Our client Asha Patel has died/.test(t)), tasks.join(' | '));
  assert.ok(tasks.some((t) => /^Chase The Lender: Tell the lender/.test(t)), tasks.join(' | '));
});

test('client names come from the matter record, once', () => {
  assert.deepEqual(clientNamesOf('SALE', ['Buyer One'], ['Seller One', ' Seller Two ']), ['Seller One', 'Seller Two']);
  assert.deepEqual(clientNamesOf('PURCHASE', ['Buyer One'], ['Seller One']), ['Buyer One']);
  let s: MatterState = { ...base, enrolled: true, transactionType: 'freehold_purchase', stage: 'pre_contract' };
  s = fold(s, { type: 'record_client_names', names: ['Asha Patel', 'Ben Carter'] });
  assert.deepEqual(s.partyNames, ['Asha Patel', 'Ben Carter']);
  assert.ok(Object.values(s.partyChecks).some((p) => p.label === 'Ben Carter'), 'the second client is identified too');
  assert.throws(() => fold(s, { type: 'record_client_names', names: ['Someone Else'] }), /already named/);
});
