/**
 * An effect that fails (a proposal that could not be written, an update that could not go)
 * is not only a line in the server log: it is written on the case as an issue, so a person
 * sees that the engine did not do what it should have, and why.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openIssues } from '../../../lib/server/engine/types';
import { harness, resolve, idClear, TENANT, MATTER, USER } from './helpers';

test('an effect that fails is written on the case as an issue carrying the reason, once', async () => {
  const h = harness();
  h.ports.autoStartOnEnrol = true;
  await h.store.setLevel(TENANT, 'client_update', 'propose');
  h.ports.documents.createGenerated = async () => { throw new Error('document store unavailable'); };
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: false, requiredSearches: [], requireProofOfFunds: false, requireExchangeAuthority: false });
  const s = await h.svc.getState(TENANT, MATTER);
  const issues = openIssues(s).filter((i) => i.kind === 'other');
  assert.equal(issues.length, 1, 'one issue for the failed effect');
  assert.match(issues[0].title, /could not act on matter created/);
  assert.match(issues[0].detail ?? '', /document store unavailable/);
  assert.equal(issues[0].gate, 'none', 'it tells; it holds nothing');
  assert.equal(s.stage, 'instruction');
});

test('a send that fails after a person approved it becomes a task: the reason in plain words, the fix, and the message to send by hand', async () => {
  const h = harness();
  await h.store.setLevel(TENANT, 'client_update', 'propose');
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: false, requiredSearches: ['CON29'], requireProofOfFunds: false, requireExchangeAuthority: false });
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  await h.svc.idCheckResultReceived(TENANT, MATTER, h.doc(idClear()));
  // The search order went (auto); the "searches ordered" update to the client was proposed. The mailbox is dead when the person says yes.
  let s = await h.svc.getState(TENANT, MATTER);
  const proposal = Object.values(s.proposals).find((p) => p.status === 'pending' && p.action === 'client_update');
  assert.ok(proposal, 'the client update is proposed');
  h.ports.clientComms.sendStatusUpdate = async () => { throw new Error('Refresh token missing; reconnect required'); };
  h.ports.messagePreview = async () => ({ kind: 'message', to: 'Jane (the client) · jane@example.com', subject: 'Your purchase — searches ordered', body: 'Hello Jane,\n\nWe have ordered the searches.' });
  await resolve(h, proposal!.eventId, 'approve');
  s = await h.svc.getState(TENANT, MATTER);
  const issue = openIssues(s).find((i) => i.kind === 'send_failed');
  assert.ok(issue, 'the failed send is on the case as a task');
  assert.match(issue!.title, /^The update to the client did not go: Your Microsoft 365 connection has expired/);
  assert.match(issue!.detail ?? '', /Connect Microsoft 365/);
  assert.match(issue!.detail ?? '', /To: Jane \(the client\)/);
  assert.match(issue!.detail ?? '', /Hello Jane/);
  assert.match(issue!.detail ?? '', /Error text for support: Refresh token missing/);
  assert.equal(issue!.gate, 'none');
  assert.equal(Object.values(s.proposals).find((p) => p.eventId === proposal!.eventId)?.status, 'failed');
});

test('a failed send can be tried again in one click: the same message goes, the proposal stands as done, the failure task closes', async () => {
  const h = harness();
  await h.store.setLevel(TENANT, 'client_update', 'propose');
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: false, requiredSearches: ['CON29'], requireProofOfFunds: false, requireExchangeAuthority: false });
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  await h.svc.idCheckResultReceived(TENANT, MATTER, h.doc(idClear()));
  let s = await h.svc.getState(TENANT, MATTER);
  const proposal = Object.values(s.proposals).find((p) => p.status === 'pending' && p.action === 'client_update')!;
  const realSend = h.ports.clientComms.sendStatusUpdate.bind(h.ports.clientComms);
  h.ports.clientComms.sendStatusUpdate = async () => { throw new Error('Graph account not connected for this user'); };
  await resolve(h, proposal.eventId, 'approve');
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.proposals[proposal.eventId].status, 'failed');
  const task = openIssues(s).find((i) => i.kind === 'send_failed')!;
  assert.ok(task && task.detail!.includes(`[proposal:${proposal.eventId}]`), 'the task knows which action to retry');

  // The mailbox is reconnected; the person presses Try Again.
  h.ports.clientComms.sendStatusUpdate = realSend;
  const before = h.ports.clientComms.sent.length;
  await h.svc.retryFailedAction(TENANT, MATTER, proposal.eventId, USER);
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(h.ports.clientComms.sent.length, before + 1, 'the same message went');
  assert.equal(s.proposals[proposal.eventId].status, 'approved');
  assert.equal(s.issues[task.id].status, 'resolved');
  await assert.rejects(h.svc.retryFailedAction(TENANT, MATTER, proposal.eventId, USER), /Only a failed action/);
});

test('the proof-of-funds form can be sent again with the same link', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: false, requiredSearches: [], requireProofOfFunds: true, requireExchangeAuthority: false });
  await h.svc.requestProofOfFunds(TENANT, MATTER, USER);
  const first = h.ports.clientComms.sent.filter((m) => m.template === 'proof_of_funds_request');
  assert.equal(first.length, 1);
  await h.svc.resendProofOfFunds(TENANT, MATTER, USER);
  const again = h.ports.clientComms.sent.filter((m) => m.template === 'proof_of_funds_request');
  assert.equal(again.length, 2);
  assert.equal((again[1].context as { formUrl: string }).formUrl, (again[0].context as { formUrl: string }).formUrl, 'the same link, not a new round');
  const s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.proofOfFunds.rounds ?? 1, 1);
  assert.ok(s.clientUpdateLastSentAt.proof_of_funds_request, 'the resend is on the record');
});
