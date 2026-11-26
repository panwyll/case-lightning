/**
 * With no case system connected, the fee earner's sent email is the only record of work done in their own system:
 * searches ordered, enquiries raised, the pack or the report sent. Read for what the firm says it HAS done, each as a
 * line a person ticks (docs/spec/triggers.md, "Sent email is read for what the firm did").
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeterministicNoteReader, firmActsIn, validateNoteActions } from '../../../lib/server/engine/notes';
import type { NoteSender, SenderRelation, TransactionType } from '../../../lib/server/engine/types';
import { harness, TENANT, MATTER, USER } from './helpers';

const US: NoteSender = { address: 'fe@ourfirm.example', name: 'Fee Earner', relation: 'colleague', sent: true };
const acts = (t: string, to: SenderRelation[] = ['other_side'], side = 'buyer') => firmActsIn(t, { to, side }).map((d) => (d.command as { act: string }).act);

test('the firm saying it has done its own steps is read; plans, questions and replies are not', () => {
  assert.deepEqual(acts('I have today ordered the searches via InfoTrack.'), ['searches_ordered']);
  assert.deepEqual(acts('The searches have now been submitted.'), ['searches_ordered']);
  assert.deepEqual(acts("We've ordered the local, drainage and environmental searches."), ['searches_ordered']);
  assert.deepEqual(acts('Please find attached our pre-contract enquiries.'), ['enquiries_raised']);
  assert.deepEqual(acts('Our additional enquiries are as follows:'), ['enquiries_raised']);
  assert.deepEqual(acts('Please find attached our report on title. If you have any questions, give me a call.', ['client']), ['report_on_title_sent']);
  assert.deepEqual(acts('Please find attached the draft contract and supporting documents.', ['other_side'], 'seller'), ['contract_pack_sent']);
  assert.deepEqual(acts('We have submitted the SDLT return, UTRN 123456789MC.', ['client']), ['sdlt_submitted']);
  assert.equal(firmActsIn('We have submitted the SDLT return, UTRN 123456789MC.', { to: ['client'], side: 'buyer' })[0].command && (firmActsIn('We have submitted the SDLT return, UTRN 123456789MC.', { to: ['client'], side: 'buyer' })[0].command as { reference?: string }).reference, '123456789MC');
  assert.equal((firmActsIn('I have today ordered the searches via InfoTrack.', { to: [], side: 'buyer' })[0].command as { detail: string }).detail, 'InfoTrack');

  // Not done yet.
  assert.deepEqual(acts('Once your funds arrive I will order the searches.'), []);
  assert.deepEqual(acts('I will order the searches tomorrow.'), []);
  assert.deepEqual(acts('Would you like us to order the searches?'), []);
  assert.deepEqual(acts('I am about to send our enquiries.'), []);
  // Money for the searches is not the searches.
  assert.deepEqual(acts('I have requested the funds for the searches.'), []);
  // Replies to their enquiries are the seller's side's work, not ours raised.
  assert.deepEqual(acts('Please find attached our replies to your enquiries.', ['other_side'], 'seller'), []);
  assert.deepEqual(acts('Please find attached our replies to your enquiries.'), []);
  // Papers for our client to sign are not the contract pack.
  assert.deepEqual(acts('Please find attached the contract papers for signature.', ['client'], 'seller'), []);
});

test('each step counts only when it went to who it goes to, on the side that does it', () => {
  assert.deepEqual(acts('Please find attached our report on title.', ['other_side']), [], 'the report goes to the client');
  assert.deepEqual(acts('Please find attached our enquiries.', ['client']), [], 'enquiries go to the other side');
  assert.deepEqual(acts('Please find attached the draft contract.', ['other_side'], 'buyer'), [], 'the buyer does not send the contract pack');
  assert.deepEqual(acts('I have ordered the searches.', ['client'], 'seller'), [], 'the seller does not order searches');
});

test("only the firm's own email records what the firm did", () => {
  const text = 'I have ordered the searches via InfoTrack.';
  const drafts = firmActsIn(text);
  for (const relation of ['client', 'other_side', 'agent', 'lender', 'unknown'] as const) {
    const { actions } = validateNoteActions(text, drafts, { kind: 'email', from: { address: 'x@y.example', name: null, relation } });
    assert.ok(actions.every((a) => !a.command), `${relation}: information only`);
  }
  const { actions } = validateNoteActions(text, drafts, { kind: 'email', from: US });
  assert.equal(actions.filter((a) => a.command?.type === 'record_firm_act').length, 1);
});

async function enrolled(transactionType: TransactionType = 'freehold_purchase', requiredSearches: Array<'LLC1' | 'CON29' | 'DRAINAGE_WATER'> = ['LLC1', 'CON29', 'DRAINAGE_WATER']) {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, transactionType, hasLender: false, requiredSearches });
  h.ports.noteExtractor = new DeterministicNoteReader();
  return h;
}

async function sent(h: Awaited<ReturnType<typeof enrolled>>, text: string, to: SenderRelation[]) {
  const documentId = h.doc(null, 'EMAIL');
  return h.svc.recordNote(TENANT, MATTER, { text, kind: 'email', actor: USER, documentId, from: US, sent: { to } });
}

async function approveAll(h: Awaited<ReturnType<typeof enrolled>>) {
  const s0 = await h.svc.getState(TENANT, MATTER);
  const note = Object.values(s0.notes).filter((n) => n.decisionEventId && s0.decisions[n.decisionEventId]?.status === 'pending').at(-1)!;
  await h.svc.openDecisionSource(TENANT, MATTER, note.decisionEventId!, USER);
  await h.svc.resolveDecision(TENANT, MATTER, note.decisionEventId!, USER, 'approve');
  return h.svc.getState(TENANT, MATTER);
}

test('a sent email to the other side: the searches and the enquiries, one task, nothing sent, recorded once ticked', async () => {
  const h = await enrolled();
  const before = await h.svc.getState(TENANT, MATTER);
  const res = await sent(h, 'Dear Colleagues,\nPlease find attached our pre-contract enquiries.\nI have today ordered the searches via InfoTrack.\nKind regards', ['other_side']);
  const note = Object.values(res.state.notes).at(-1)!;
  assert.deepEqual(note.actions.filter((a) => a.command).map((a) => (a.command as { act: string }).act).sort(), ['enquiries_raised', 'searches_ordered']);
  assert.ok(note.decisionEventId, 'a person ticks it');
  assert.equal(h.ports.clientComms.sent.length, 0, 'nobody is written to from our own email');
  assert.ok(!note.messages?.length, 'no reply is drafted to our own email');
  assert.equal(Object.keys(res.state.searches).length, Object.keys(before.searches).length, 'nothing recorded until a person approves');

  const after = await approveAll(h);
  const orders = (await h.store.listEvents(TENANT, MATTER)).filter((e) => e.type === 'search_ordered');
  for (const t of ['LLC1', 'CON29', 'DRAINAGE_WATER'] as const) {
    assert.equal(after.searches[t]?.status, 'ordered', `${t} on order`);
    const order = orders.find((e) => (e.payload as { searchType: string }).searchType === t);
    assert.match((order?.payload as { provider: string }).provider, /InfoTrack \(ordered outside CONVEYi\)/);
    assert.equal(order?.actor, USER, 'under the name of the person who ticked it');
  }
  assert.equal(Object.values(after.enquiries).length, 1, 'the enquiries are raised, so their replies are matched and chased');
  // What follows is the steps' own: the client hears as if the steps were recorded by hand (at the firm's trust level).
  assert.deepEqual(h.ports.clientComms.sent.map((m) => m.template).sort(), ['enquiries_raised', 'searches_ordered']);
});

test('a plan in a sent email is nothing: no task, the email is still filed', async () => {
  const h = await enrolled();
  const res = await sent(h, 'Once your funds arrive I will order the searches.', ['client']);
  const note = Object.values(res.state.notes).at(-1)!;
  assert.equal(note.actions.length, 0);
  assert.ok(!note.decisionEventId);
});

test('seller side: the contract pack sent from the case system is recorded, even before the forms are on CONVEYi', async () => {
  const h = await enrolled('freehold_sale', []);
  await sent(h, 'Dear Colleagues,\nPlease find attached the draft contract and supporting documents.\nRegards', ['other_side']);
  const after = await approveAll(h);
  assert.ok(after.contractPack.sentAt, 'the pack is recorded as sent');
  assert.ok(after.manualSteps?.contract_pack, 'as Mark Complete records it');
});

test('buyer side: the report on title sent to the client is recorded', async () => {
  const h = await enrolled();
  await sent(h, 'Dear Jo,\nPlease find attached our report on title. If you have any questions, give me a call.', ['client']);
  const after = await approveAll(h);
  assert.equal(after.reportOnTitle.status, 'sent');
});

test('a step done outside is recorded by a person, and only the firm\'s own acts: never a check', async () => {
  const h = await enrolled('freehold_sale', []);
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'record_done_outside', actor: 'system', step: 'contract_pack', note: 'x' } as never), /by a person/);
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'record_done_outside', actor: USER, step: 'id_check', note: 'x' } as never), /not a step recorded/);
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'record_search_ordered', actor: 'system', searchType: 'LLC1', provider: 'x', outside: true }), /by a person/);
});
