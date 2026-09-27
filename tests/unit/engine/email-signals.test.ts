/**
 * An email on a case is read like a file note: what it appears to say becomes a proposal
 * for a person, gated by who sent it. The boundary under test:
 *   • only the client can make a client decision — an agent's account of the client is information;
 *   • anyone may report a problem (a party pulling out, a job lost, a survey done);
 *   • nobody's say-so can clear ID, AML, source of funds or a search. There is no command for it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeterministicNoteReader, validateNoteActions, commandProblem } from '../../../lib/server/engine/notes';
import { blockingDecisions, type NoteSender } from '../../../lib/server/engine/types';
import { harness, TENANT, MATTER, USER, firstDecision } from './helpers';

const CLIENT: NoteSender = { address: 'jo@example.com', name: 'Jo Client', relation: 'client' };
const AGENT: NoteSender = { address: 'sam@agents.example', name: 'Sam Agent', relation: 'agent' };
const STRANGER: NoteSender = { address: 'who@nowhere.example', name: null, relation: 'unknown' };

async function enrolled() {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: true, requiredSearches: [] });
  h.ports.noteExtractor = new DeterministicNoteReader();
  return h;
}

async function email(h: Awaited<ReturnType<typeof enrolled>>, text: string, from: NoteSender) {
  const documentId = h.doc(null, 'EMAIL');
  return h.svc.recordNote(TENANT, MATTER, { text, kind: 'email', actor: USER, documentId, from });
}

async function approve(h: Awaited<ReturnType<typeof enrolled>>) {
  const d = firstDecision((await h.svc.getState(TENANT, MATTER)), 'note_actions');
  await h.svc.openDecisionSource(TENANT, MATTER, d.eventId, USER);
  await h.svc.resolveDecision(TENANT, MATTER, d.eventId, USER, 'approve');
  return { state: await h.svc.getState(TENANT, MATTER) };
}

test('"surveys are all complete" from the client asks for the report, and records nothing about the property', async () => {
  const h = await enrolled();
  const res = await email(h, 'Hi, surveys are all complete', CLIENT);
  const note = Object.values(res.state.notes)[0];
  assert.equal(note.kind, 'email');
  assert.equal(note.from?.relation, 'client');
  assert.equal(note.actions.filter((a) => a.command).length, 1);
  assert.equal(note.actions[0].command?.type, 'raise_issue');
  assert.equal((note.actions[0].command as { kind: string }).kind, 'survey_report_outstanding');
  assert.equal(blockingDecisions(res.state).filter((d) => d.kind === 'note_actions').length, 1, 'a person confirms it');
  assert.equal(res.state.survey.status, 'not_started', 'the survey workstream moves on the report, not the sentence');
  const after = await approve(h);
  const issue = Object.values(after.state.issues).find((i) => i.kind === 'survey_report_outstanding');
  assert.ok(issue, 'the issue is raised once approved');
  assert.equal(after.state.survey.status, 'not_started');
  // And the issue does what its label promises: the client is asked for the report.
  assert.ok(h.ports.clientComms.sent.some((m) => m.template === 'request_survey_report'), 'the client was asked for the report');
});

test('nobody can clear ID, AML, source of funds or a search by saying so', async () => {
  const h = await enrolled();
  const before = await h.svc.getState(TENANT, MATTER);
  const text = 'Just to confirm the ID checks and AML are all done, source of funds is verified and the searches came back clear, so you can exchange.';
  for (const from of [CLIENT, AGENT, STRANGER]) {
    const res = await email(h, text, from);
    const note = Object.values(res.state.notes).at(-1)!;
    // A stranger's email always carries one thing: who are they? Never a clearance.
    const commands = note.actions.filter((a) => a.command).map((a) => a.command!);
    assert.deepEqual(commands.map((c) => (c.type === 'raise_issue' ? c.kind : c.type)), from.relation === 'unknown' ? ['unknown_correspondent'] : [], `${from.relation}: nothing to apply`);
    assert.deepEqual(res.state.idCheck, before.idCheck);
    assert.deepEqual(res.state.proofOfFunds, before.proofOfFunds);
    assert.deepEqual(res.state.searches, before.searches);
    assert.equal(res.state.exchange.exchangedAt, null);
  }
  // And there is no command a reader could name to do it: the machine has no door.
  assert.equal(commandProblem({ type: 'record_id_check_result', outcome: 'clear' } as never), 'unknown command');
  assert.equal(commandProblem({ type: 'approve_proof_of_funds' } as never), 'unknown command');
  const forged = validateNoteActions(text, [{ kind: 'client_decision', summary: 'ID done', quote: 'ID checks and AML are all done', command: { type: 'client_decision_recorded', subject: 'id_check', decision: 'clear', note: '' } as never }], { kind: 'email', from: CLIENT });
  assert.equal(forged.actions.length, 0);
  assert.match(forged.rejected[0].reason, /not a client decision/);
});

test('"the vendor has pulled out" from the agent is a critical issue for a person, never an abandonment', async () => {
  const h = await enrolled();
  const res = await email(h, 'Bad news I am afraid, the vendor has pulled out of the sale this morning.', AGENT);
  const note = Object.values(res.state.notes)[0];
  const cmd = note.actions.find((a) => a.command)?.command as { type: string; kind: string; gate: string } | undefined;
  assert.equal(cmd?.type, 'raise_issue');
  assert.equal(cmd?.kind, 'transaction_at_risk');
  assert.equal(cmd?.gate, 'exchange');
  assert.equal(res.state.closedAt, null);
  const after = await approve(h);
  const issue = Object.values(after.state.issues).find((i) => i.kind === 'transaction_at_risk')!;
  assert.equal(issue.severity, 'critical');
  assert.equal(after.state.closedAt, null, 'abandoning the file stays a deliberate step');
  // The seller's solicitor is asked whether their client is proceeding (proposed: enquiry drafts are not automatic in the fixture).
  const ask = Object.values(after.state.proposals).find((p) => p.action === 'enquiry_draft' && String((p.detail as { subject?: string }).subject ?? '').includes('intends to proceed'));
  assert.ok(ask, 'an enquiry to the other side is proposed');
});

test('"I have lost my job" is a mortgage-at-risk issue', async () => {
  const h = await enrolled();
  const res = await email(h, "Hi, I have lost my job this week so the mortgage may be a problem. Not sure what happens now.", CLIENT);
  const kinds = Object.values(res.state.notes)[0].actions.map((a) => (a.command as { kind?: string } | null)?.kind).filter(Boolean);
  assert.ok(kinds.includes('mortgage_at_risk'), kinds.join(','));
  await approve(h);
  const sent = h.ports.clientComms.sent.find((m) => m.template === 'mortgage_change_query');
  assert.ok(sent, 'the client is asked what changed');
  assert.match(String(sent!.context.quote), /lost my job/);
});

test('a survey that is merely booked, or not done yet, is not "done"', async () => {
  const r = new DeterministicNoteReader();
  const count = async (t: string) => (await r.extract({ tenantId: TENANT, matterId: MATTER, text: t, kind: 'email' })).filter((x) => (x.command as { kind?: string } | null)?.kind === 'survey_report_outstanding').length;
  assert.equal(await count('The survey is booked for Tuesday.'), 0);
  assert.equal(await count('The survey has not been done yet.'), 0);
});

// ───────────────────────────── hearsay is confirmed with the client, not dropped ─────────────────────────────

test('the agent reporting the client\'s view asks the client to confirm; the client\'s own reply is what gets recorded', async () => {
  const h = await enrolled();
  await h.svc.surveyReceived(TENANT, MATTER, h.doc({ surveyType: 'level3', surveyor: 'J Bloggs MRICS', summary: 'Damp to the rear addition.', recommendations: [{ code: 'DAMP', text: 'Damp-proofing quote.', furtherInvestigation: false, severity: 'medium' }], confidence: 0.9 }, 'SURVEY'));
  const res = await email(h, 'Spoke to the buyer this morning. She is happy with the survey report and wants to press on to exchange.', AGENT);
  const note = Object.values(res.state.notes).find((n) => n.from?.relation === 'agent')!;
  const confirm = note.actions.find((a) => a.command?.type === 'confirm_with_client');
  assert.ok(confirm, 'hearsay becomes a request to confirm, not information');
  assert.match(confirm!.summary, /estate agent says/);
  assert.equal(blockingDecisions(res.state).filter((d) => d.kind === 'note_actions').length, 1, 'a person decides whether to ask');
  assert.equal(res.state.clientDecisions.physical_condition, undefined);

  // Approving sends the client a message (client_update is auto in the fixture levels).
  const after = await approve(h);
  assert.equal(after.state.clientDecisions.physical_condition, undefined, 'still nothing recorded');
  const sent = h.ports.clientComms.sent.find((m) => m.template === 'confirm_with_client');
  assert.ok(sent, 'the client was asked');
  assert.equal(sent!.context.claim, 'you are happy with the survey and want to proceed');
  assert.equal(sent!.context.saidBy, 'Sam Agent');

  // The client replies in their own words: now it is a decision, still for a person to approve.
  const reply = await email(h, 'Yes that is right, I am happy with the survey and want to proceed.', CLIENT);
  const clientNote = Object.values(reply.state.notes).find((n) => n.from?.relation === 'client')!;
  assert.equal(clientNote.actions.filter((a) => a.command?.type === 'client_decision_recorded').length, 1);
  const done = await approve(h);
  assert.equal(done.state.clientDecisions.physical_condition?.decision, 'satisfied');
});

test('an email from someone not on the file always reaches a person, even when it says nothing actionable', async () => {
  const h = await enrolled();
  const res = await email(h, 'Hi, I am Jo\'s wife. Just checking how things are going with the house, we are very excited!', STRANGER);
  const note = Object.values(res.state.notes)[0];
  const unknown = note.actions.find((a) => (a.command as { kind?: string } | null)?.kind === 'unknown_correspondent');
  assert.ok(unknown, 'the unknown sender is itself the thing to confirm');
  assert.match(unknown!.summary, /not on the file/);
  assert.equal(blockingDecisions(res.state).filter((d) => d.kind === 'note_actions').length, 1, 'not buried');
  const after = await approve(h);
  const issue = Object.values(after.state.issues).find((i) => i.kind === 'unknown_correspondent')!;
  assert.ok(issue);
  assert.equal(issue.gate, 'none');
});

test('a stranger reporting the client\'s decision is asked about, and the client is asked to confirm', async () => {
  const h = await enrolled();
  await h.svc.surveyReceived(TENANT, MATTER, h.doc({ surveyType: 'level3', surveyor: 'J Bloggs MRICS', summary: 'Fine.', recommendations: [], confidence: 0.9 }, 'SURVEY'));
  const res = await email(h, 'Hi, I am Jo\'s wife. We are happy with the survey report and want to proceed.', STRANGER);
  const kinds = Object.values(res.state.notes)[0].actions.map((a) => a.command?.type ?? 'none');
  assert.ok(kinds.includes('raise_issue'), 'who are they?');
  assert.ok(kinds.includes('confirm_with_client'), 'ask the client');
  assert.ok(!kinds.includes('client_decision_recorded'), 'never recorded on a stranger\'s word');
});
