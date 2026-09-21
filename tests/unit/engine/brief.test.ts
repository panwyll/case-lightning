/**
 * The case brief (docs/architecture-review.md §15) and what it is allowed to say.
 *
 * Two registers, one source. Internally the brief names issues, dates and decisions,
 * because the person drafting has the authority to use them. To a client it may describe
 * process only — and on a case with a live legal problem it may not answer at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, resolve, firstDecision, TENANT, MATTER, USER, idClear, searchClear, titleClear } from './helpers';
import { caseBrief, clientStatusAnswer, renderForDrafting } from '../../../lib/server/engine/brief';
import { DEFAULT_SLA } from '../../../lib/server/engine/sla';
import { isStatusQuestion, guardClientQuestion } from '../../../lib/server/comms/guard';

/** A buyer matter that is genuinely mid-flight: ID cleared, searches out, one chased. */
async function midFlight() {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: false, requiredSearches: ['CON29', 'LLC1'], requireProofOfFunds: false, requireExchangeAuthority: false });
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  await h.svc.idCheckResultReceived(TENANT, MATTER, h.doc(idClear()));
  await h.svc.searchReturned(TENANT, MATTER, 'LLC1', h.doc(searchClear('LLC1')));
  h.advanceDays(Math.ceil(DEFAULT_SLA.search.chaseAfter * 1.4) + 1);
  await h.svc.tick(TENANT, MATTER); // the timer chases the outstanding CON29
  return h;
}

test('brief: the engine\'s account of a matter, in one shape', async () => {
  const h = await midFlight();
  const b = caseBrief(await h.svc.getState(TENANT, MATTER), h.ports.now());
  assert.equal(b.enrolled, true);
  assert.equal(b.transactionLabel, 'Freehold purchase');
  assert.equal(b.side, 'buyer');
  assert.equal(b.lifecycleLabel, 'Pre-exchange');
  const con29 = b.waiting.find((w) => w.subject === 'CON29')!;
  assert.ok(con29, 'the outstanding search is in the brief');
  assert.equal(con29.who, 'the local authority and search providers', 'a role the client would recognise, never a firm name');
  assert.equal(con29.chasesSent, 1);
  assert.ok(con29.sinceWorkingDays >= DEFAULT_SLA.search.chaseAfter);
  assert.ok(b.workstreams.some((w) => w.id === 'id_aml' && w.status === 'complete'));
});

test('brief for drafting: facts a fee-earner may use, and an instruction not to invent others', async () => {
  const h = await midFlight();
  const text = renderForDrafting(caseBrief(await h.svc.getState(TENANT, MATTER), h.ports.now()));
  assert.match(text, /Freehold purchase/);
  assert.match(text, /Outstanding with others:/);
  assert.match(text, /a property search \(CON29\) — with the local authority and search providers, \d+ working days, 1 chase sent/);
  assert.match(text, /Do not state anything about this matter that is not above or in the thread\./);
});

test('"any update?" is answered from the case: who has it, when we chased, when we chase next, and that there is nothing for them to do', async () => {
  const h = await midFlight();
  const b = caseBrief(await h.svc.getState(TENANT, MATTER), h.ports.now());
  const s = clientStatusAnswer(b);
  assert.ok(s.canAnswer, `expected an answer: ${s.canAnswer === false ? s.reason : ''}`);
  if (!s.canAnswer) return;
  assert.match(s.text, /ID \/ AML is complete|complete/i);
  assert.match(s.text, /waiting for the local authority and search providers/);
  assert.match(s.text, /We chased (today|yesterday|\d+ days ago)/);
  assert.match(s.text, /There is nothing you need to do at the moment\./);
  // The register is process-only: no money, no legal terms, no internal identifiers.
  assert.doesNotMatch(s.text, /£|\bCON29\b|\bissue\b|ISS-|restriction|covenant|title defect/i);
  assert.ok(isStatusQuestion('Any update?') && isStatusQuestion('any news on this?') && isStatusQuestion("how's it going?"));
  assert.ok(!isStatusQuestion('What does exchange mean?'));
});

test('the client is told what WE need from them, when that is the thing holding it up', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: false, requiredSearches: [], requireProofOfFunds: false, requireExchangeAuthority: false });
  await h.svc.requestIdCheck(TENANT, MATTER, USER); // the client owes us their ID
  const s = clientStatusAnswer(caseBrief(await h.svc.getState(TENANT, MATTER), h.ports.now()));
  assert.ok(s.canAnswer);
  if (!s.canAnswer) return;
  assert.match(s.text, /we do still need your identity check from you/i);
  assert.doesNotMatch(s.text, /nothing you need to do/i);
});

test('a machine does not reassure a client whose case has a legal problem on it — it fetches a person', async () => {
  const h = await midFlight();
  await h.svc.run(TENANT, MATTER, { type: 'raise_issue', actor: USER, kind: 'title_defect', title: 'Restriction in the register requires a certificate on transfer', gate: 'exchange' });
  const blocked = clientStatusAnswer(caseBrief(await h.svc.getState(TENANT, MATTER), h.ports.now()));
  assert.equal(blocked.canAnswer, false);
  if (blocked.canAnswer) return;
  assert.match(blocked.reason, /holds exchange/);

  // …and the same for a payment hard stop, which is the moment fraud happens.
  const h2 = await midFlight();
  await h2.svc.recordBankDetails(TENANT, MATTER, { actor: USER, payeeKind: 'seller_solicitor', payeeRef: 'Smith & Co', details: { sortCode: '401234', accountNumber: '11112222', accountName: 'Smith & Co Client Account', firmName: 'Smith & Co' }, sourceChannel: 'email', sourceDocumentId: h2.doc({ content: 'email' }) });
  const stop = clientStatusAnswer(caseBrief(await h2.svc.getState(TENANT, MATTER), h2.ports.now()));
  assert.equal(stop.canAnswer, false);
  if (stop.canAnswer) return;
  assert.match(stop.reason, /hard stop/);
});

test('the guard still comes first: a status question that is really a transaction question is blocked', () => {
  // "any update" phrasing does not launder a question about their own searches.
  assert.ok(guardClientQuestion('Any update on my search results?').blocked);
  assert.ok(!guardClientQuestion('Any update?').blocked);
});

test('a chase to a third party also tells the client — once a day, never while an issue holds the matter', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: false, requiredSearches: ['CON29', 'LLC1'], requireProofOfFunds: false, requireExchangeAuthority: false });
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  await h.svc.idCheckResultReceived(TENANT, MATTER, h.doc(idClear()));
  h.ports.clientComms.sent.length = 0;
  h.advanceDays(Math.ceil(DEFAULT_SLA.search.chaseAfter * 1.4) + 1);
  await h.svc.tick(TENANT, MATTER);

  const updates = h.ports.clientComms.sent.filter((x) => x.template === 'chase_update');
  assert.equal(updates.length, 1, 'two searches chased in one sweep is one update, not two');
  assert.match(String(updates[0].context.waitingOn), /local authority/);
  assert.match(String(updates[0].context.waitingFor), /property search/);
  const state = await h.svc.getState(TENANT, MATTER);
  assert.ok(state.clientUpdateLastSentAt.chase_update, 'the matter remembers it told them');

  // A second sweep the same day says nothing further.
  await h.svc.tick(TENANT, MATTER);
  assert.equal(h.ports.clientComms.sent.filter((x) => x.template === 'chase_update').length, 1);

  // Once an issue holds exchange, the automated reassurance stops.
  await h.svc.run(TENANT, MATTER, { type: 'raise_issue', actor: USER, kind: 'title_defect', title: 'Restriction in the register', gate: 'exchange' });
  h.advanceDays(5);
  await h.svc.tick(TENANT, MATTER);
  assert.equal(h.ports.clientComms.sent.filter((x) => x.template === 'chase_update').length, 1, 'no cheerful update while the case is blocked');
});

test('a chase to the CLIENT is not paired with an update telling the client we chased them', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: false, requiredSearches: [], requireProofOfFunds: false, requireExchangeAuthority: false });
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  h.ports.clientComms.sent.length = 0;
  h.advanceDays(Math.ceil(DEFAULT_SLA.id_check.chaseAfter * 1.4) + 2);
  await h.svc.tick(TENANT, MATTER);
  assert.ok(h.ports.chaser.chases.some((c) => c.recipientRole === 'client'), 'the client was chased');
  assert.equal(h.ports.clientComms.sent.filter((x) => x.template === 'chase_update').length, 0);
  void resolve; void firstDecision; void titleClear;
});
