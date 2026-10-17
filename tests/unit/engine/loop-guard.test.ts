/** No automatic reply loops: someone whose email still waits on a person is sent nothing unasked. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recipientOf, unansweredFrom } from '../../../lib/server/engine/loop-guard';
import type { MatterState } from '../../../lib/server/engine/types';

const note = (id: string, relation: string, status: string, at: string) => ({ id, kind: 'email', text: '', author: 'external', at, documentId: null, durationSeconds: null, from: { address: 'x@y.test', name: null, relation }, actions: [], extractor: null, decisionEventId: null, status });
const state = (notes: ReturnType<typeof note>[]) => ({ notes: Object.fromEntries(notes.map((n) => [n.id, n])) }) as unknown as MatterState;

test("a client's email waiting on a person holds anything automatic to the client, and only to them", () => {
  const s = state([note('n1', 'client', 'proposed', '2026-10-16T10:00:00Z'), note('n0', 'other_side', 'applied', '2026-10-15T10:00:00Z')]);
  assert.equal(unansweredFrom(s, 'client')?.id, 'n1');
  assert.equal(unansweredFrom(s, 'seller_solicitor'), null, 'their email has been dealt with');
  assert.equal(unansweredFrom(s, 'estate_agent'), null);
});

test('once a person has dealt with it, automatic messages go again', () => {
  assert.equal(unansweredFrom(state([note('n1', 'client', 'applied', '2026-10-16T10:00:00Z')]), 'client'), null);
});

test('who an automatic message is to', () => {
  assert.equal(recipientOf('acknowledgement', { recipientRole: 'seller_solicitor' }), 'seller_solicitor');
  assert.equal(recipientOf('counterparty_update', { to: 'estate_agent' }), 'estate_agent');
  assert.equal(recipientOf('client_update', {}), 'client');
  assert.equal(recipientOf('search_order', {}), null);
});
