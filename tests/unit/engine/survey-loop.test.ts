/**
 * The survey loop as it happens: the surveyor recommends a specialist → the client says pursue
 * → an access enquiry goes to the seller's solicitor → their conditions are told to the client
 * → the specialist reports clear → the client can say they are satisfied. Or the client waives.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openIssues } from '../../../lib/server/engine/types';
import { harness, TENANT, MATTER, USER, idClear } from './helpers';

const survey = () => ({ surveyType: 'level2' as const, recommendations: [{ code: 'DAMP', text: 'a damp and timber specialist to lift floorboards in the rear reception room', furtherInvestigation: true, specialist: 'Damp and timber surveyor', severity: 'high' as const }], confidence: 0.9 });

async function toPreContract(h: ReturnType<typeof harness>) {
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: false, requiredSearches: [], requireProofOfFunds: false, requireExchangeAuthority: false });
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  await h.svc.idCheckResultReceived(TENANT, MATTER, h.doc(idClear()));
}

test('pursue: access is asked of the seller, their conditions reach the client, the specialist clears it, the client can then be satisfied', async () => {
  const h = harness();
  await h.store.setLevel(TENANT, 'enquiry_draft', 'auto'); // the fixture's other actions are auto; the enquiry draft defaults to propose
  await toPreContract(h);
  await h.svc.surveyReceived(TENANT, MATTER, h.doc(survey()));
  let s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.survey.status, 'further_investigation');
  const issue = openIssues(s).find((i) => i.kind === 'survey_further_investigation')!;
  assert.ok(issue);
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'client_decision_recorded', actor: USER, subject: 'physical_condition', decision: 'satisfied', note: '' }), /Further investigation is still outstanding/);

  await h.svc.run(TENANT, MATTER, { type: 'client_decision_recorded', actor: USER, subject: 'further_investigation', decision: 'pursue', note: 'Client will pay for the specialist' });
  s = await h.svc.getState(TENANT, MATTER);
  const q = Object.values(s.enquiries).find((x) => x.origin?.issueId === issue.id);
  assert.ok(q, 'an access enquiry was raised against the recommendation');
  assert.match(q!.subject, /inspections carried out before exchange[\s\S]*1\. Damp and timber specialist/);
  assert.match(q!.subject, /Client will pay/);
  assert.ok(s.issues[issue.id].enquiryIds.includes(q!.enquiryId));

  h.ports.clientComms.sent.length = 0;
  await h.svc.enquiryReplyReceived(TENANT, MATTER, q!.enquiryId, h.doc({ enquiryId: q!.enquiryId, status: 'answered', issues: [], confidence: 0.9 }));
  const told = h.ports.clientComms.sent.find((m) => m.template === 'access_conditions');
  assert.ok(told, "the seller's reply on access is told to the client");
  assert.match(String((told!.context as { specialist: string }).specialist), /Damp and timber specialist/);

  await h.svc.specialistReportReceived(TENANT, MATTER, h.doc({ surveyType: 'specialist', recommendations: [], confidence: 0.9 }), issue.id);
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.issues[issue.id].status, 'resolved');
  assert.equal(s.survey.status, 'awaiting_client');
  await h.svc.run(TENANT, MATTER, { type: 'client_decision_recorded', actor: USER, subject: 'physical_condition', decision: 'satisfied', note: '' });
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.survey.status, 'client_satisfied');
});

test('waive: the client accepts the risk in writing, the recommendation closes as accepted as is, and no enquiry goes out', async () => {
  const h = harness();
  await toPreContract(h);
  await h.svc.surveyReceived(TENANT, MATTER, h.doc(survey()));
  await h.svc.run(TENANT, MATTER, { type: 'client_decision_recorded', actor: USER, subject: 'further_investigation', decision: 'waive', note: 'Advised in writing; client accepts the damp risk' });
  const s = await h.svc.getState(TENANT, MATTER);
  const issue = Object.values(s.issues).find((i) => i.kind === 'survey_further_investigation')!;
  assert.equal(issue.status, 'resolved');
  assert.equal(issue.resolution, 'accepted_as_is');
  assert.equal(Object.keys(s.enquiries).length, 0);
  assert.equal(s.survey.status, 'awaiting_client');
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'client_decision_recorded', actor: USER, subject: 'further_investigation', decision: 'waive', note: 'again' }), /No further investigation is outstanding/);
});
