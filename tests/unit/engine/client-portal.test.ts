/**
 * The client portal (docs/spec/ui.md "Client portal"): the case as the client sees it. It shows the
 * client's own steps and what is waiting on them, each with the way to do it, and never an issue.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientPortalView } from '../../../lib/server/engine/client-portal';
import { withPortal, PORTAL_LINE, SURVEY_LINE, ProductionClientComms } from '../../../lib/server/comms/client-comms';
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
  assert.deepEqual(v.journey.map((s) => s.label), ['Instruction', 'Investigation', 'Enquiries', 'Contract & Exchange', 'Completion', 'Registration']);
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

test('the completion message on every kind of case asks how we did, linking to the rating; others carry the plain portal line', async () => {
  const sent: Array<{ subject: string; text: string }> = [];
  const info = { matterRef: 'R', propertyAddress: '1 Oak St', firmName: 'Firm', feeEarnerName: 'Pat', feeEarnerUserId: null, clientFirstName: 'Priya', clientEmail: 'p@example.com', clientPhone: null, clientWhatsAppOptIn: false, contacts: {}, completionDate: null };
  const comms = new ProductionClientComms({
    contactInfo: async () => ({ ...info, transaction: 'sale' as const }), whatsapp: null, mailbox: null,
    email: { send: async (m) => { sent.push({ subject: m.subject, text: m.text }); return { messageId: 'x' }; } },
    log: async () => {}, routeToHuman: async () => {}, matterForAddress: async () => null, tenantForAddress: async () => null, chaseMode: 'send',
    portalLink: async () => 'https://app.test/portal/abc', surveysOn: async () => true,
  });
  await comms.sendStatusUpdate({ tenantId: 't', matterId: 'm', template: 'completed', context: {} });
  await comms.sendStatusUpdate({ tenantId: 't', matterId: 'm', template: 'searches_ordered', context: {} });
  assert.match(sent[0].subject, /sale/);
  assert.ok(sent[0].text.includes(`${SURVEY_LINE.completed}\nhttps://app.test/portal/abc`), sent[0].text);
  assert.ok(sent[1].text.includes(PORTAL_LINE) && !sent[1].text.includes(SURVEY_LINE.completed));
});
