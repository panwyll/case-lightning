/**
 * What a conveyancer does with the buyer's survey: the surveyor's points for the legal adviser
 * become enquiries to the seller's solicitor; the condition findings go to the client, whose
 * decision holds exchange. Nothing about condition is decided here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, TENANT, MATTER, USER } from './helpers';
import { surveyAdvice, surveyEnquiry } from '../../../lib/server/engine/survey-review';
import type { SurveyFacts } from '../../../lib/server/engine/types';

const REPORT: SurveyFacts = {
  surveyType: 'level2',
  surveyor: 'J Bloggs MRICS',
  summary: 'A 1930s semi in fair condition.',
  recommendations: [
    { code: 'ROOF', text: 'Slipped and missing roof tiles to the rear slope; repair urgently.', furtherInvestigation: false, severity: 'high', rating: 3 },
    { code: 'DAMP', text: 'Damp to the rear wall; a damp specialist should investigate before exchange.', furtherInvestigation: true, specialist: 'damp and timber specialist', severity: 'medium', rating: 2 },
    { code: 'WINDOWS', text: 'Some sealed units have failed.', furtherInvestigation: false, severity: 'low', rating: 2 },
  ],
  legalIssues: [
    { category: 'regulation', text: 'The rear extension: obtain planning permission and building regulations completion certificate.' },
    { category: 'guarantee', text: 'Replacement windows: obtain FENSA certificate.' },
    { category: 'other', text: 'Confirm the right of way over the shared side passage.' },
  ],
  risks: ['Trees within falling distance of the house.'],
  marketValuePennies: 42_000_000,
  reinstatementCostPennies: 31_500_000,
  confidence: 0.9,
};

async function enrolled() {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: true, requiredSearches: [] });
  await h.svc.run(TENANT, MATTER, { type: 'record_price_change', actor: USER, toPennies: 43_500_000, reason: 'agreed price' });
  return h;
}

test('each point for the legal adviser becomes an enquiry to the seller\'s solicitor, in a conveyancer\'s words', () => {
  assert.match(surveyEnquiry(REPORT.legalIssues![0]), /planning permission and the building regulations approval and completion certificate/);
  assert.match(surveyEnquiry(REPORT.legalIssues![1]), /guarantee or warranty.*transferable/);
  assert.match(surveyEnquiry(REPORT.legalIssues![2]), /right of way over the shared side passage\. Please confirm the position/);
});

test('the client letter covers what is urgent, what to investigate, what we are raising, the value gap and insurance', () => {
  const b = surveyAdvice(REPORT, { purchasePricePennies: 43_500_000, freehold: true, hasLender: true });
  assert.match(b.urgentBlock, /condition rating 3[\s\S]*Slipped and missing roof tiles[\s\S]*written quotations[\s\S]*before you are legally committed/);
  assert.doesNotMatch(b.urgentBlock, /sealed units/, 'a rating 2 item is not urgent');
  assert.match(b.investigateBlock, /Damp to the rear wall.*\(damp and timber specialist\)/);
  assert.match(b.legalBlock, /3 points[\s\S]*raising these with the seller's solicitor/);
  assert.match(b.valueBlock, /£420,000, below the £435,000/);
  assert.match(b.insuranceBlock, /£315,000[\s\S]*from exchange/);
  const leasehold = surveyAdvice(REPORT, { purchasePricePennies: 43_500_000, freehold: false, hasLender: true });
  assert.equal(leasehold.insuranceBlock, '', 'a leaseholder\'s building is insured by the landlord');
});

test('a survey on file gives the conveyancer tasks: the enquiries are proposed and the client is written to', async () => {
  const h = await enrolled();
  const res = await h.svc.surveyReceived(TENANT, MATTER, h.doc(REPORT, 'SURVEY'));
  const s = await h.svc.getState(TENANT, MATTER);
  const enquiries = Object.values(s.proposals).filter((p) => p.action === 'enquiry_draft' && p.status === 'pending');
  assert.equal(enquiries.length, 3, 'one proposed enquiry per legal point (a person approves each at Propose)');
  const sent = h.ports.clientComms.sent.find((m) => m.template === 'survey_advice');
  assert.ok(sent, 'the client letter (client updates are unasked in the fixture)');
  assert.match(String(sent!.context.urgentBlock), /roof tiles/);
  // The damp investigation holds exchange as a warning (rated 2), not critical.
  const damp = Object.values(s.issues).find((i) => i.kind === 'survey_further_investigation')!;
  assert.equal(damp.severity, 'warning');
  assert.equal(damp.gate, 'exchange');
  assert.ok(res.state.survey.status === 'further_investigation');
});

test('reading the same survey again replaces the reading and repeats nothing', async () => {
  const h = await enrolled();
  const docId = h.doc(REPORT, 'SURVEY');
  await h.svc.surveyReceived(TENANT, MATTER, docId);
  const first = await h.svc.getState(TENANT, MATTER);
  await h.svc.surveyReceived(TENANT, MATTER, docId);
  const again = await h.svc.getState(TENANT, MATTER);
  assert.equal(again.survey.reports.length, 1);
  assert.equal(Object.values(again.issues).filter((i) => i.kind === 'survey_further_investigation').length, 1);
  assert.equal(Object.values(again.proposals).filter((p) => p.action === 'enquiry_draft').length, Object.values(first.proposals).filter((p) => p.action === 'enquiry_draft').length);
  assert.equal(h.ports.clientComms.sent.filter((m) => m.template === 'survey_advice').length, 1);
});

test('the client can change their mind: waive the investigation, then want it after all', async () => {
  const h = await enrolled();
  await h.svc.surveyReceived(TENANT, MATTER, h.doc(REPORT, 'SURVEY'));
  await h.svc.run(TENANT, MATTER, { type: 'client_decision_recorded', actor: USER, subject: 'further_investigation', decision: 'waive', note: 'Client happy to proceed without the damp survey' });
  let s = await h.svc.getState(TENANT, MATTER);
  assert.equal(Object.values(s.issues).filter((i) => i.kind === 'survey_further_investigation' && i.status === 'open').length, 0);
  await h.svc.run(TENANT, MATTER, { type: 'client_decision_recorded', actor: USER, subject: 'further_investigation', decision: 'pursue', note: 'Client has changed their mind; wants the damp specialist in' });
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(Object.values(s.issues).filter((i) => i.kind === 'survey_further_investigation' && i.status === 'open').length, 1, 'the investigation is back');
  assert.equal(s.clientDecisions.further_investigation?.decision, 'pursue');
  assert.equal(s.survey.status, 'further_investigation');
});
