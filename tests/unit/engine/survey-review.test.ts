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
  assert.match(b.investigateBlock, /Damp and timber specialist: Damp to the rear wall/);
  assert.match(b.legalBlock, /3 points with the seller[\s\S]*raising them with the seller's solicitor/);
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
  assert.equal(enquiries.length, 1, 'one numbered set of enquiries, not one per point');
  assert.match(String(enquiries[0].detail.subject), /1\. The rear extension[\s\S]*2\. Replacement windows[\s\S]*3\. Confirm the right of way/);
  const sent = h.ports.clientComms.sent.find((m) => m.template === 'survey_advice');
  assert.ok(sent, 'the client letter (client updates are unasked in the fixture)');
  assert.match(String(sent!.context.adviceBody), /roof tiles/, 'without a model the template letter carries the substance');
  // The damp investigation holds exchange as a warning (rated 2), not critical.
  const damp = Object.values(s.issues).find((i) => i.kind === 'survey_further_investigation')!;
  assert.equal(damp.severity, 'info', 'a suggestion on record, not an alarm');
  assert.equal(damp.gate, 'none', 'the survey holds exchange on the client\'s one decision, not per check');
  assert.equal(res.state.survey.status, 'awaiting_client');
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
  assert.equal(s.survey.status, 'awaiting_client');
});

test('a failed reading raises no placeholder investigation, and a good one reads normally', async () => {
  const h = await enrolled();
  const docId = h.doc(REPORT, 'SURVEY');
  await h.svc.run(TENANT, MATTER, { type: 'survey_received', actor: 'external', documentId: docId, surveyType: 'level2', facts: { surveyType: 'level2', recommendations: [{ code: 'UNREAD', text: 'The report could not be read automatically; a person must read it and record the recommendations.', furtherInvestigation: true, severity: 'medium' }], confidence: 0 }, extractor: 'test' } as never);
  let s = await h.svc.getState(TENANT, MATTER);
  assert.ok(!Object.values(s.issues).some((i) => /could not be read automatically/.test(i.title)), 'no investigation called "could not be read"');
  assert.equal(s.survey.reports[0].unread, true);
  await h.svc.surveyReceived(TENANT, MATTER, docId);
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.survey.reports.length, 1);
  assert.equal(s.survey.reports[0].unread, false);
  assert.equal(Object.values(s.issues).filter((i) => i.kind === 'survey_further_investigation' && i.status === 'open').length, 1);
});

test('a failed reading never becomes a letter to the client', async () => {
  const { surveyNeedsAdvice } = await import('../../../lib/server/engine/survey-review');
  assert.equal(surveyNeedsAdvice({ surveyType: 'level2', recommendations: [{ code: 'UNREAD', text: 'The report could not be read automatically; a person must read it and record the recommendations.', furtherInvestigation: true, severity: 'medium' }], confidence: 0 }), false);
  const h = await enrolled();
  await h.svc.run(TENANT, MATTER, { type: 'survey_received', actor: 'external', documentId: h.doc(null, 'SURVEY'), surveyType: 'level2', facts: { surveyType: 'level2', recommendations: [{ code: 'UNREAD', text: 'The report could not be read automatically; a person must read it and record the recommendations.', furtherInvestigation: true, severity: 'medium' }], confidence: 0 }, extractor: 'test' } as never);
  assert.equal(h.ports.clientComms.sent.filter((m) => m.template === 'survey_advice').length, 0);
});

test('the guard holds a message that looks wrong, whatever produced it', async () => {
  const { messageProblem } = await import('../../../lib/server/comms/templates');
  const ok = { subject: 'Your purchase of 9 Arthur Road — your survey', body: 'Hello Peter,\n\nWe have read your survey and raised three points with the seller\'s solicitor.\n\nPeter Anwyll' };
  assert.equal(messageProblem(ok), null);
  assert.match(messageProblem({ ...ok, body: ok.body + '\n• The report could not be read automatically; a person must read it' })!, /could not read/);
  assert.match(messageProblem({ ...ok, body: 'Hello {{firstName}}, your offer is attached and all is well with the purchase.' })!, /placeholder/);
  assert.match(messageProblem({ ...ok, body: 'Hello Peter, the deposit of undefined is due before exchange next week.' })!, /undefined/);
  assert.match(messageProblem({ ...ok, body: 'Hello Peter, please transfer £0 to our client account before completion.' })!, /£0/);
  assert.match(messageProblem({ ...ok, missing: ['property'] })!, /missing property/);
});

test('twenty sentences about the same things become one set of enquiries and one issue per specialist', async () => {
  const { investigationGroups, surveyEnquiries, sortLegalPoints } = await import('../../../lib/server/engine/survey-review');
  const recs = [
    { code: 'A', text: 'There are signs of movement noted; a structural engineer should inspect.', furtherInvestigation: true, severity: 'high' as const, rating: 3 as const },
    { code: 'B', text: 'Cracking/leaning indicative of movement stress to the garden wall.', furtherInvestigation: true, severity: 'medium' as const, rating: 2 as const },
    { code: 'C', text: 'Localised dampness and musty smells were noted.', furtherInvestigation: true, severity: 'medium' as const, rating: 2 as const },
    { code: 'D', text: 'Penetrative damp staining to the ceiling.', furtherInvestigation: true, severity: 'medium' as const, rating: 2 as const },
    { code: 'E', text: 'Obtain a CCTV survey of the underground drains.', furtherInvestigation: true, severity: 'medium' as const, rating: 2 as const },
    { code: 'F', text: 'A test of the electrical installation by an NICEIC contractor.', furtherInvestigation: true, severity: 'medium' as const, rating: 2 as const },
    { code: 'G', text: 'We would recommend the resistance of the cabling is tested.', furtherInvestigation: true, severity: 'medium' as const, rating: 2 as const },
    { code: 'H', text: 'A test of the heating, boiler and hot water cylinder by a Gas Safe engineer.', furtherInvestigation: true, severity: 'medium' as const, rating: 2 as const },
  ];
  const groups = investigationGroups(recs).map((g) => [g.specialist, g.items.length, g.urgent]);
  assert.deepEqual(groups.sort(), [['Damp and timber specialist', 2, false], ['Drainage (CCTV) survey', 1, false], ['Electrician', 2, false], ['Gas and heating engineer', 1, false], ['Structural engineer', 2, true]].sort());
  const { seller, ours } = sortLegalPoints([
    { category: 'regulation', text: 'Confirm Local Authority approval for the removal of the chimney breast.' },
    { category: 'regulation', text: 'Confirm local authority approval for the removal of the chimney breast' },
    { category: 'guarantee', text: 'Obtain the guarantees for double glazing.' },
    { category: 'other', text: 'Ensure home insurance is available on standard terms.' },
    { category: 'other', text: 'Enquire of the Local Authority as to whether the property stands on made ground.' },
  ]);
  assert.equal(seller.length, 2, 'the duplicate is dropped; insurance and the search point are not for the seller');
  assert.equal(ours.length, 2);
  const batch = surveyEnquiries(seller)!;
  assert.match(batch, /^Additional enquiries arising from our client's survey:\n1\. Confirm Local Authority approval[\s\S]*\n2\. Obtain the guarantees for double glazing\. Please supply the guarantee/);
});

test('a survey on file proposes one set of enquiries and, when the client wants the specialists, one access request', async () => {
  const h = await enrolled();
  await h.svc.surveyReceived(TENANT, MATTER, h.doc(REPORT, 'SURVEY'));
  let s = await h.svc.getState(TENANT, MATTER);
  assert.equal(Object.values(s.proposals).filter((p) => p.action === 'enquiry_draft' && p.status === 'pending').length, 1);
  await h.svc.run(TENANT, MATTER, { type: 'client_decision_recorded', actor: USER, subject: 'further_investigation', decision: 'pursue', note: 'Wants the damp specialist in' });
  s = await h.svc.getState(TENANT, MATTER);
  const access = Object.values(s.proposals).filter((p) => p.action === 'enquiry_draft' && p.status === 'pending' && p.dedupKey.startsWith('enquiry_draft:access-batch:'));
  assert.equal(access.length, 1);
  assert.match(String(access[0].detail.subject), /1\. Damp and timber specialist/);
});

test('advice first: the letter offers evidence, access or neither; nothing goes to the seller until the client says', async () => {
  const b = surveyAdvice(REPORT, { purchasePricePennies: 43_500_000, freehold: true, hasLender: true });
  assert.match(b.investigateBlock, /three ways to go:\n1\. We ask the seller's solicitor for anything that already answers it, for example any damp-proofing[\s\S]*If you have had a specialist look already, send us their report\.\n2\. We ask for access[\s\S]*3\. You go ahead without it/);
  assert.match(b.investigateBlock, /we will not contact the seller's side about these until you do/);
  const h = await enrolled();
  await h.svc.surveyReceived(TENANT, MATTER, h.doc(REPORT, 'SURVEY'));
  let s = await h.svc.getState(TENANT, MATTER);
  assert.equal(Object.values(s.proposals).filter((p) => /access-batch|evidence-batch/.test(p.dedupKey)).length, 0, 'the survey alone asks the seller for nothing about inspections');
  // The client asks for the seller's evidence first.
  await h.svc.run(TENANT, MATTER, { type: 'client_decision_recorded', actor: USER, subject: 'further_investigation', decision: 'evidence' });
  s = await h.svc.getState(TENANT, MATTER);
  const ev = Object.values(s.proposals).find((p) => p.dedupKey.startsWith('enquiry_draft:evidence-batch:'));
  assert.ok(ev, 'one evidence enquiry');
  assert.match(String(ev!.detail.subject), /Before our client instructs specialists[\s\S]*1\. Damp and timber specialist[\s\S]*damp-proofing or timber treatment reports and guarantees/);
  assert.equal(Object.values(s.proposals).filter((p) => p.dedupKey.startsWith('enquiry_draft:access-batch:')).length, 0, 'no access request until they want the specialists in');
});

test('reading the survey again after the client chose to investigate proposes nothing new to the seller', async () => {
  const h = await enrolled();
  const docId = h.doc(REPORT, 'SURVEY');
  await h.svc.surveyReceived(TENANT, MATTER, docId);
  await h.svc.run(TENANT, MATTER, { type: 'client_decision_recorded', actor: USER, subject: 'further_investigation', decision: 'pursue', note: 'Wants the specialists in' });
  const before = Object.values((await h.svc.getState(TENANT, MATTER)).proposals).filter((p) => p.action === 'enquiry_draft').length;
  await h.svc.surveyReceived(TENANT, MATTER, docId);
  const after = Object.values((await h.svc.getState(TENANT, MATTER)).proposals).filter((p) => p.action === 'enquiry_draft' && p.status === 'pending').length;
  assert.ok(after <= before);
});

test("the client's instruction is per specialist: leave the drains, ask about the damp, get a structural engineer in", async () => {
  const two = { ...REPORT, recommendations: [
    ...REPORT.recommendations,
    { code: 'MOVE', text: 'Cracking to the rear wall; a structural engineer should inspect before exchange.', furtherInvestigation: true, specialist: 'structural engineer', severity: 'high' as const, rating: 3 as const },
    { code: 'DRAIN', text: 'Obtain a CCTV survey of the underground drains.', furtherInvestigation: true, severity: 'medium' as const, rating: 2 as const },
  ] };
  const h = await enrolled();
  await h.svc.surveyReceived(TENANT, MATTER, h.doc(two, 'SURVEY'));
  let s = await h.svc.getState(TENANT, MATTER);
  const id = (name: RegExp) => Object.values(s.issues).find((i) => i.kind === 'survey_further_investigation' && name.test(i.title))!.id;
  const damp = id(/Damp/), structural = id(/Structural/), drains = id(/Drainage/);
  const batches = () => Object.values(s.proposals).filter((p) => p.status === 'pending' && /^enquiry_draft:(access|evidence)-batch:/.test(p.dedupKey));

  await h.svc.run(TENANT, MATTER, { type: 'client_decision_recorded', actor: USER, subject: 'further_investigation', decision: 'waive', note: 'Not worried about the drains', scope: [drains] });
  await h.svc.run(TENANT, MATTER, { type: 'client_decision_recorded', actor: USER, subject: 'further_investigation', decision: 'evidence', scope: [damp] });
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.issues[drains].status, 'resolved', 'the drains are left, and only the drains');
  assert.equal(s.issues[structural].status, 'open');
  let b = batches();
  assert.equal(b.length, 1);
  assert.match(String(b[0].detail.subject), /Damp and timber specialist/);
  assert.doesNotMatch(String(b[0].detail.subject), /Structural|Drainage/, 'nothing the client did not ask about goes to the seller');

  await h.svc.run(TENANT, MATTER, { type: 'client_decision_recorded', actor: USER, subject: 'further_investigation', decision: 'pursue', note: 'Get an engineer in', scope: [structural] });
  s = await h.svc.getState(TENANT, MATTER);
  b = batches();
  assert.equal(b.length, 2);
  const access = b.find((p) => p.dedupKey.startsWith('enquiry_draft:access-batch:'))!;
  assert.match(String(access.detail.subject), /1\. Structural engineer/);
  assert.doesNotMatch(String(access.detail.subject), /Damp|Drainage/);

  // They change their mind about the damp: the pending request for it is taken back.
  await h.svc.run(TENANT, MATTER, { type: 'client_decision_recorded', actor: USER, subject: 'further_investigation', decision: 'waive', note: 'Will deal with the damp after completion', scope: [damp] });
  s = await h.svc.getState(TENANT, MATTER);
  b = batches();
  assert.deepEqual(b.map((p) => p.dedupKey.split(':')[1]), ['access-batch'], 'only the structural access request is left');
});

test("the client's reply is read against the survey letter: their instruction becomes one drafted enquiry, nothing else", async () => {
  const h = await enrolled();
  await h.svc.surveyReceived(TENANT, MATTER, h.doc(REPORT, 'SURVEY'));
  const CLIENT = { address: 'jo@example.com', name: 'Jo Client', relation: 'client' as const };
  let seen: string | undefined;
  // A reader that sees the context and does what the model is told to: one enquiry covering what the client asked for.
  h.ports.noteExtractor = { name: 'test', extract: async (input) => { seen = input.context; return [{ kind: 'client_decision', summary: 'Client wants the damp guarantee and the window certificate', quote: 'ask them for the damp guarantee and the FENSA', command: { type: 'request_from_seller', about: 'damp guarantee and FENSA', text: "Our client asks that your client supply: 1. any damp-proofing guarantee for the rear wall; 2. the FENSA certificate for the replacement windows." } }]; } };
  await h.svc.recordNote(TENANT, MATTER, { text: 'Thanks. Not worried about the roof, but please ask them for the damp guarantee and the FENSA before we go further.', kind: 'email', actor: USER, documentId: h.doc(null, 'EMAIL'), from: CLIENT });
  assert.match(seen ?? '', /wrote to the client about their survey[\s\S]*Rated urgent: Slipped and missing roof tiles/);
  let s = await h.svc.getState(TENANT, MATTER);
  const d = Object.values(s.decisions).find((x) => x.kind === 'note_actions' && x.status === 'pending')!;
  await h.svc.openDecisionSource(TENANT, MATTER, d.eventId, USER);
  await h.svc.resolveDecision(TENANT, MATTER, d.eventId, USER, 'approve');
  s = await h.svc.getState(TENANT, MATTER);
  const enq = Object.values(s.proposals).filter((p) => p.status === 'pending' && p.dedupKey.startsWith('enquiry_draft:client:'));
  assert.equal(enq.length, 1);
  assert.match(String(enq[0].detail.subject), /damp-proofing guarantee[\s\S]*FENSA/);
  assert.doesNotMatch(String(enq[0].detail.subject), /\broof\b|structural|drain/i, 'only what the client asked for');
});

test('a re-read only refreshes the reading; Send Recommendations replaces what is pending, even after a letter went', async () => {
  const h = await enrolled();
  const docId = h.doc(REPORT, 'SURVEY');
  await h.svc.surveyReceived(TENANT, MATTER, docId);
  const letters = () => h.ports.clientComms.sent.filter((m) => m.template === 'survey_advice').length;
  const first = letters();
  assert.equal(first, 1, 'the first reading writes to the client');
  await h.svc.run(TENANT, MATTER, { type: 'propose_action', action: 'enquiry_draft', subject: 'survey', detail: { subject: 'Old access request' }, dedupKey: 'enquiry_draft:access-batch:ISS-9', summary: 'old', sourceDocumentId: docId } as never);
  // A plain re-read: nothing new is proposed or sent.
  await h.svc.surveyReceived(TENANT, MATTER, docId);
  assert.equal(letters(), first);
  // The person asks for the recommendations again: a new letter, new enquiries, the leftover request withdrawn.
  await h.svc.sendSurveyRecommendations(TENANT, MATTER, docId);
  assert.equal(letters(), first + 1);
  const s = await h.svc.getState(TENANT, MATTER);
  assert.ok(!Object.values(s.proposals).some((p) => p.status === 'pending' && p.dedupKey === 'enquiry_draft:access-batch:ISS-9'));
  assert.equal(Object.values(s.proposals).filter((p) => p.status === 'pending' && p.dedupKey.startsWith(`enquiry_draft:survey:${docId}`)).length, 1, 'one set of enquiries, the new one');
});
