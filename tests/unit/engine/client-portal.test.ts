/**
 * The client portal (docs/spec/ui.md "Client portal"): the case as the client sees it. It shows the
 * client's own steps and what is waiting on them, each with the way to do it, and never an issue.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientPortalView } from '../../../lib/server/engine/client-portal';
import { withPortal, PORTAL_LINE } from '../../../lib/server/comms/client-comms';
import { harness, TENANT, MATTER, USER } from './helpers';

async function purchase() {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: true, requiredSearches: ['LLC1'], requireProofOfFunds: true, requireExchangeAuthority: false });
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  await h.svc.requestProofOfFunds(TENANT, MATTER, USER);
  return h;
}

test('a new purchase: the client\'s steps, and their ID check and proof of funds as tasks with the way to do each', async () => {
  const h = await purchase();
  const v = clientPortalView(await h.svc.getState(TENANT, MATTER), h.ports.now());
  assert.deepEqual(v.journey.map((s) => s.label), ['Getting Started', 'Searches, Checks And Enquiries', 'Ready To Exchange', 'Exchanged', 'Completed']);
  assert.equal(v.journey.filter((s) => s.state === 'current').length, 1);
  const titles = v.tasks.map((t) => t.title);
  assert.ok(titles.includes('Identity Check') && titles.includes('Proof Of Funds'), titles.join(', '));
  const pof = v.tasks.find((t) => t.title === 'Proof Of Funds')!;
  assert.equal(pof.action.type, 'link', 'the form opens from the portal');
  assert.ok(v.progress.some((p) => p.label === 'Identity Check' && p.state === 'with_you'));
  assert.ok(v.progress.every((p) => !/AML|lender \//i.test(p.label)), 'client words, not internal labels');
});

test('an issue never shows: the step it holds reads In Progress, and its words appear nowhere', async () => {
  const h = await purchase();
  await h.svc.run(TENANT, MATTER, { type: 'raise_issue', actor: USER, kind: 'title_defect', title: 'Restriction in the register requires a certificate on transfer', gate: 'exchange' });
  const v = clientPortalView(await h.svc.getState(TENANT, MATTER), h.ports.now());
  const all = JSON.stringify(v);
  assert.doesNotMatch(all, /Restriction|title_defect|blocked|at_risk|under_review|flag/i);
  assert.ok(v.progress.every((p) => ['done', 'in_progress', 'with_you', 'not_started'].includes(p.state)));
});

test('money is never asked for on the page: the deposit task says call us and that our bank details never change by email', async () => {
  const h = await purchase();
  const s = await h.svc.getState(TENANT, MATTER);
  s.waits.push({ ...s.waits.find((w) => !w.closedAt)!, key: 'deposit', subject: '' });
  const v = clientPortalView(s, h.ports.now());
  const dep = v.tasks.find((t) => t.title === 'Deposit');
  assert.ok(dep, v.tasks.map((t) => t.title).join(', '));
  assert.equal(dep!.action.type, 'call');
  assert.match(dep!.detail, /never change our bank details by email/);
  assert.doesNotMatch(JSON.stringify(v), /sort code|account number/i);
});

test('an abandoned case reads Closed, with nothing asked of the client', async () => {
  const h = await purchase();
  await h.svc.run(TENANT, MATTER, { type: 'abandon_matter', actor: USER, reason: 'client_withdrew' });
  const v = clientPortalView(await h.svc.getState(TENANT, MATTER), h.ports.now());
  assert.equal(v.closed, true);
  assert.equal(v.stageLabel, 'Closed');
  assert.deepEqual(v.tasks, []);
});

test('the portal line goes in above a short sign-off, once', () => {
  const url = 'https://app.test/portal/abc';
  const signed = withPortal('Hello Priya,\n\nYour searches are back.\n\nKind regards', url);
  assert.equal(signed, `Hello Priya,\n\nYour searches are back.\n\n${PORTAL_LINE}\n${url}\n\nKind regards`);
  assert.ok(withPortal('One long paragraph with no sign-off that keeps going well past sixty characters in length.', url).endsWith(url));
});
