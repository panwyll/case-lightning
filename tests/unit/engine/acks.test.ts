import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, TENANT, MATTER, USER, idClear } from './helpers';
import { EXTERNAL } from '../../../lib/server/engine/types';

/**
 * Acknowledgements: whoever sends us something hears that it arrived, at once, so they
 * never write again to ask. One per item; one per party per delivery; nothing in shadow.
 */
async function enrolled() {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, requireProofOfFunds: false, requireExchangeAuthority: false, hasLender: false, requiredSearches: ['LLC1'] });
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  await h.svc.idCheckResultReceived(TENANT, MATTER, h.doc(idClear()));
  return h;
}

test('a reply to enquiries from the other side is acknowledged once and recorded as an event', async () => {
  const h = await enrolled();
  await h.svc.run(TENANT, MATTER, { type: 'raise_enquiry', actor: USER, enquiryId: 'E1', subject: 'boundaries' });
  await h.svc.run(TENANT, MATTER, { type: 'enquiry_reply_received', actor: EXTERNAL, enquiryId: 'E1', documentId: h.doc({}) });
  assert.equal(h.ports.chaser.acks.length, 1);
  assert.equal(h.ports.chaser.acks[0].recipientRole, 'seller_solicitor');
  const log = h.store.dump(TENANT, MATTER);
  const ack = log.find((e) => e.type === 'acknowledgement_sent');
  assert.ok(ack, 'the acknowledgement is on the log');
  const reply = log.find((e) => e.type === 'enquiry_reply_received')!;
  assert.equal((ack!.payload as { forEventId: string }).forEventId, reply.id);
  const s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.acknowledgements.length, 1);
});

test('several items from the same party inside a few hours are one acknowledgement, not several', async () => {
  const h = await enrolled();
  await h.svc.run(TENANT, MATTER, { type: 'raise_enquiry', actor: USER, enquiryId: 'E1', subject: 'a' });
  await h.svc.run(TENANT, MATTER, { type: 'raise_enquiry', actor: USER, enquiryId: 'E2', subject: 'b' });
  await h.svc.run(TENANT, MATTER, { type: 'enquiry_reply_received', actor: EXTERNAL, enquiryId: 'E1', documentId: h.doc({}) });
  await h.svc.run(TENANT, MATTER, { type: 'enquiry_reply_received', actor: EXTERNAL, enquiryId: 'E2', documentId: h.doc({}) });
  assert.equal(h.ports.chaser.acks.length, 1);
  // The next day is a new delivery.
  h.advanceDays(1);
  await h.svc.run(TENANT, MATTER, { type: 'raise_enquiry', actor: USER, enquiryId: 'E3', subject: 'c' });
  await h.svc.run(TENANT, MATTER, { type: 'enquiry_reply_received', actor: EXTERNAL, enquiryId: 'E3', documentId: h.doc({}) });
  assert.equal(h.ports.chaser.acks.length, 2);
});

test('the client is acknowledged on their own channel for what they send; nothing goes to anyone for a search result', async () => {
  const h = await enrolled();
  await h.svc.surveyReceived(TENANT, MATTER, h.doc({ surveyType: 'homebuyer', condition: 'fair', defects: [], recommendations: [], confidence: 0.9 }, 'SURVEY'));
  assert.equal(h.ports.chaser.acks.length, 1);
  assert.equal(h.ports.chaser.acks[0].recipientRole, 'client');
  await h.svc.run(TENANT, MATTER, { type: 'search_returned', actor: EXTERNAL, searchType: 'LLC1', documentId: h.doc({}) });
  assert.equal(h.ports.chaser.acks.length, 1, 'a search provider is not a party to acknowledge');
});

test('at PROPOSE the acknowledgement is proposed, not sent; approving it sends it', async () => {
  const h = harness();
  await h.store.setLevel(TENANT, 'acknowledgement', 'propose', null);
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, requireProofOfFunds: false, requireExchangeAuthority: false, hasLender: false, requiredSearches: ['LLC1'] });
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  await h.svc.idCheckResultReceived(TENANT, MATTER, h.doc(idClear()));
  await h.svc.run(TENANT, MATTER, { type: 'raise_enquiry', actor: USER, enquiryId: 'E1', subject: 'a' });
  await h.svc.run(TENANT, MATTER, { type: 'enquiry_reply_received', actor: EXTERNAL, enquiryId: 'E1', documentId: h.doc({}) });
  assert.equal(h.ports.chaser.acks.length, 0, 'nothing sent');
  const s = await h.svc.getState(TENANT, MATTER);
  const proposal = Object.values(s.proposals).find((p) => p.action === 'acknowledgement')!;
  assert.ok(proposal, 'the acknowledgement was proposed');
  const d = s.decisions[proposal.eventId];
  assert.equal(d.kind, 'proposal');
  await h.svc.openDecisionSource(TENANT, MATTER, d.eventId, USER);
  await h.svc.resolveDecision(TENANT, MATTER, d.eventId, USER, 'approve');
  assert.equal(h.ports.chaser.acks.length, 1, 'approved → sent');
  assert.equal((await h.svc.getState(TENANT, MATTER)).proposals[proposal.eventId].status, 'approved');
});

test('the machine refuses to record the same acknowledgement twice', async () => {
  const h = await enrolled();
  await h.svc.run(TENANT, MATTER, { type: 'raise_enquiry', actor: USER, enquiryId: 'E1', subject: 'a' });
  const r = await h.svc.run(TENANT, MATTER, { type: 'enquiry_reply_received', actor: EXTERNAL, enquiryId: 'E1', documentId: h.doc({}) });
  const reply = r.events.find((e) => e.type === 'enquiry_reply_received')!;
  await assert.rejects(
    h.svc.run(TENANT, MATTER, { type: 'record_acknowledgement', ack: { forEventId: reply.id, forEventType: 'enquiry_reply_received', recipientRole: 'seller_solicitor', what: 'x', channel: 'mock' } }),
    /already been acknowledged/
  );
});
