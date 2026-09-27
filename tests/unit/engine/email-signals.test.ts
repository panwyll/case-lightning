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
});

test('the agent saying the buyer is happy with the survey is information, not a client decision', async () => {
  const h = await enrolled();
  await h.svc.surveyReceived(TENANT, MATTER, h.doc({ surveyType: 'level3', surveyor: 'J Bloggs MRICS', summary: 'Damp to the rear addition.', recommendations: [{ code: 'DAMP', text: 'Damp-proofing quote.', furtherInvestigation: false, severity: 'medium' }], confidence: 0.9 }, 'SURVEY'));
  const text = 'Spoke to the buyer this morning. She is happy with the survey report and wants to press on to exchange.';
  const fromAgent = await email(h, text, AGENT);
  const agentNote = Object.values(fromAgent.state.notes).find((n) => n.from?.relation === 'agent')!;
  assert.ok(agentNote.actions.length >= 1, 'the sentence is still read');
  assert.equal(agentNote.actions.filter((a) => a.command).length, 0, 'but nothing is proposed');
  assert.match(agentNote.actions[0].summary, /said by the estate agent, not the client/);
  assert.equal(blockingDecisions(fromAgent.state).filter((d) => d.kind === 'note_actions').length, 0, 'no decision when there is nothing to apply');
  assert.equal(fromAgent.state.clientDecisions.physical_condition, undefined);

  // The same words from the client are a decision the person can approve.
  const fromClient = await email(h, text, CLIENT);
  const clientNote = Object.values(fromClient.state.notes).find((n) => n.from?.relation === 'client')!;
  assert.equal(clientNote.actions.filter((a) => a.command?.type === 'client_decision_recorded').length, 1);
  const after = await approve(h);
  assert.equal(after.state.clientDecisions.physical_condition?.decision, 'satisfied');
});

test('nobody can clear ID, AML, source of funds or a search by saying so', async () => {
  const h = await enrolled();
  const before = await h.svc.getState(TENANT, MATTER);
  const text = 'Just to confirm the ID checks and AML are all done, source of funds is verified and the searches came back clear, so you can exchange.';
  for (const from of [CLIENT, AGENT, STRANGER]) {
    const res = await email(h, text, from);
    const note = Object.values(res.state.notes).at(-1)!;
    assert.equal(note.actions.filter((a) => a.command).length, 0, `${from.relation}: nothing to apply`);
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
});

test('"I have lost my job" is a mortgage-at-risk issue', async () => {
  const h = await enrolled();
  const res = await email(h, "Hi, I have lost my job this week so the mortgage may be a problem. Not sure what happens now.", CLIENT);
  const kinds = Object.values(res.state.notes)[0].actions.map((a) => (a.command as { kind?: string } | null)?.kind).filter(Boolean);
  assert.ok(kinds.includes('mortgage_at_risk'), kinds.join(','));
});

test('a survey that is merely booked, or not done yet, is not "done"', async () => {
  const r = new DeterministicNoteReader();
  const count = async (t: string) => (await r.extract({ tenantId: TENANT, matterId: MATTER, text: t, kind: 'email' })).filter((x) => (x.command as { kind?: string } | null)?.kind === 'survey_report_outstanding').length;
  assert.equal(await count('The survey is booked for Tuesday.'), 0);
  assert.equal(await count('The survey has not been done yet.'), 0);
});
