/**
 * An issue is never a dead end (docs/spec/issues.md "Next steps"): each kind offers what a person
 * does about it — write to someone (drafted from the case, edited, sent, logged on the issue),
 * agree new dates, mark it negotiating, or say it has fallen through — beside its outcomes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ISSUE_KINDS, ISSUE_KIND_SPEC, issueSteps } from '../../../lib/server/engine/issues';
import { MockClientComms } from '../../../lib/server/engine/mocks';
import { harness, TENANT, MATTER, USER } from './helpers';

test('every kind a person resolves offers a next step; transaction at risk offers the full set and a way out', () => {
  for (const k of ISSUE_KINDS) {
    if (['file_locked', 'unknown_correspondent', 'send_failed', 'document_revised'].includes(k) || ISSUE_KIND_SPEC[k].context) continue;
    assert.ok(issueSteps(k).length > 0, `${k} has next steps`);
  }
  const risk = issueSteps('transaction_at_risk').map((x) => x.kind === 'message' ? `${x.kind}:${x.to}` : x.kind);
  assert.deepEqual(risk, ['message:seller_solicitor', 'message:client', 'message:estate_agent', 'dates', 'negotiating', 'fatal']);
  assert.ok(ISSUE_KIND_SPEC.transaction_at_risk.resolutions.includes('proceeding_confirmed'));
});

test('acting for the seller, a property problem is put to our client, not the other side', () => {
  const buyer = issueSteps('building_regs_missing', 'buyer').filter((x) => x.kind === 'message').map((x) => x.kind === 'message' && x.to);
  const seller = issueSteps('building_regs_missing', 'seller').filter((x) => x.kind === 'message').map((x) => x.kind === 'message' && x.to);
  assert.deepEqual(buyer, ['seller_solicitor', 'client']);
  assert.deepEqual(seller, ['client', 'seller_solicitor']);
  assert.equal(issueSteps('building_regs_missing', 'seller')[0].label, 'Ask The Client');
});

test('a step is drafted from the case, sent as edited, and logged on the issue', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: false, requiredSearches: [] });
  await h.svc.run(TENANT, MATTER, { type: 'raise_issue', actor: USER, kind: 'transaction_at_risk', title: 'The agent says the seller may be pulling out' });
  const issue = Object.values((await h.svc.getState(TENANT, MATTER)).issues).find((i) => i.kind === 'transaction_at_risk')!;
  const ask = issueSteps('transaction_at_risk')[0];
  const draft = await h.svc.draftIssueMessage(TENANT, MATTER, issue.id, ask.id);
  assert.equal(draft.to, 'seller_solicitor');
  assert.match(draft.body, /^Dear Colleagues,/);
  assert.match(draft.body, /still proceeding/);
  assert.doesNotMatch(draft.body, /\(The agent says/, 'the issue text is not pasted in');

  await h.svc.sendIssueMessage(TENANT, MATTER, issue.id, { actor: USER, to: 'seller_solicitor', subject: draft.subject, body: 'Dear Colleagues,\n\nPlease confirm today.' });
  const chaser = h.ports.chaser as unknown as { messages: Array<{ recipientRole: string; body: string }> };
  assert.equal(chaser.messages.at(-1)!.recipientRole, 'seller_solicitor');
  assert.match(chaser.messages.at(-1)!.body, /confirm today/, 'as edited');

  const client = await h.svc.draftIssueMessage(TENANT, MATTER, issue.id, issueSteps('transaction_at_risk')[1].id);
  await h.svc.sendIssueMessage(TENANT, MATTER, issue.id, { actor: USER, to: 'client', subject: client.subject, body: client.body });
  const comms = h.ports.clientComms as MockClientComms;
  assert.equal(comms.sent.at(-1)!.template, 'email_reply');
  assert.match(comms.sent.at(-1)!.override?.body ?? '', /do not incur any further costs/);

  const after = (await h.svc.getState(TENANT, MATTER)).issues[issue.id];
  assert.equal(after.status, 'open', 'writing about it does not resolve it');
  assert.ok(after.history.some((x) => /Emailed the other side's solicitor/.test(x.what)));
  assert.ok(after.history.some((x) => /Emailed the client/.test(x.what)));
  await assert.rejects(h.svc.draftIssueMessage(TENANT, MATTER, issue.id, 'dates'), /does not write/);
});
