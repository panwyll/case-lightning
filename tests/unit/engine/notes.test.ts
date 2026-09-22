/**
 * Notes and call transcripts → proposals → events (docs/intake.md).
 *
 * The rule the whole feature rests on: a note can never put something into the case that
 * a person could not have typed themselves. Everything here is a test of that boundary.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeterministicNoteReader, validateNoteActions, commandProblem, summariseNoteActions, type NoteActionDraft } from '../../../lib/server/engine/notes';
import { blockingDecisions, type NoteAction } from '../../../lib/server/engine/types';
import type { NoteExtractor } from '../../../lib/server/engine/ports';
import { harness, TENANT, MATTER, USER, firstDecision } from './helpers';

const NOTE = [
  'Spoke to Mrs Okafor at 11:20.',
  'She is happy with the damp report and wants to press on.',
  'Her broker expects the revised mortgage offer on Friday.',
  'She mentioned in passing that the neighbour has put a fence up over the boundary.',
  'Asked after her daughter, who has just started at Leeds.',
].join(' ');

/** An extractor that returns exactly what the test tells it to. */
const reader = (drafts: NoteActionDraft[]): NoteExtractor => ({ name: 'test-reader', extract: async () => drafts });

async function enrolled() {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: true, requiredSearches: [] });
  return h;
}

/** Enrolled, with a survey on the file — the precondition for a physical-condition decision. */
async function withSurvey() {
  const h = await enrolled();
  await h.svc.surveyReceived(TENANT, MATTER, h.doc({ surveyType: 'level3', surveyor: 'J Bloggs MRICS', summary: 'Damp to the rear addition.', recommendations: [{ code: 'DAMP', text: 'Damp-proofing quote.', furtherInvestigation: false, severity: 'medium' }], confidence: 0.9 }, 'SURVEY'));
  return h;
}

// ───────────────────────────── validation ─────────────────────────────

test('a proposal that cannot quote the note is thrown away', () => {
  const { actions, rejected } = validateNoteActions(NOTE, [
    { kind: 'client_decision', summary: 'Client is satisfied', quote: 'She is happy with the damp report', command: { type: 'client_decision_recorded', subject: 'physical_condition', decision: 'satisfied', note: 'x' } },
    { kind: 'client_decision', summary: 'Client authorises exchange', quote: 'She told us to exchange today', command: { type: 'client_decision_recorded', subject: 'exchange_authority', decision: 'authorised', note: 'x' } },
  ]);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].summary, 'Client is satisfied');
  assert.match(rejected[0].reason, /not in the note/);
});

test('quoting is whitespace- and curly-quote-insensitive, but not paraphrase-tolerant', () => {
  const ok = validateNoteActions(NOTE, [{ kind: 'information', summary: 'Small talk', quote: 'happy   with the\n damp report' }]);
  assert.equal(ok.actions.length, 1);
  const no = validateNoteActions(NOTE, [{ kind: 'information', summary: 'Small talk', quote: 'content with the damp survey' }]);
  assert.equal(no.actions.length, 0);
});

test('a proposal naming a command the machine would refuse is thrown away', () => {
  assert.match(commandProblem({ type: 'client_decision_recorded', subject: 'physical_condition', decision: 'delighted', note: '' })!, /not an outcome/);
  assert.match(commandProblem({ type: 'client_decision_recorded', subject: 'mood', decision: 'good', note: '' } as never)!, /not a client decision/);
  assert.match(commandProblem({ type: 'raise_issue', kind: 'gremlins', title: 'x', detail: null, gate: 'none' } as never)!, /not an issue kind/);
  assert.equal(commandProblem({ type: 'raise_issue', kind: 'boundary_discrepancy', title: 'Fence', detail: null, gate: 'exchange' }), null);
  const { actions, rejected } = validateNoteActions(NOTE, [
    { kind: 'client_decision', summary: 'Client is delighted', quote: 'She is happy with the damp report', command: { type: 'client_decision_recorded', subject: 'physical_condition', decision: 'delighted', note: '' } },
  ]);
  assert.equal(actions.length, 0);
  assert.match(rejected[0].reason, /not an outcome/);
});

test('duplicates collapse and ids are assigned in order', () => {
  const { actions } = validateNoteActions(NOTE, [
    { kind: 'information', summary: 'Called the client', quote: 'Spoke to Mrs Okafor at 11:20' },
    { kind: 'information', summary: 'Called the client', quote: 'Spoke to Mrs Okafor at 11:20' },
    { kind: 'expectation', summary: 'Offer expected Friday', quote: 'Her broker expects the revised mortgage offer on Friday' },
  ]);
  assert.deepEqual(actions.map((a) => a.id), ['A1', 'A2']);
});

test('the summary a person reads quotes every line and says what each would do', () => {
  const { actions } = validateNoteActions(NOTE, [
    { kind: 'client_decision', summary: 'Client is satisfied with the condition', quote: 'She is happy with the damp report', command: { type: 'client_decision_recorded', subject: 'physical_condition', decision: 'satisfied', note: '' } },
    { kind: 'information', summary: 'Asked after the family', quote: 'Asked after her daughter' },
  ]);
  const s = summariseNoteActions({ kind: 'call', text: NOTE, actions });
  assert.match(s, /A call on this matter/);
  assert.match(s, /Nothing has been applied/);
  assert.match(s, /“She is happy with the damp report”/);
  assert.match(s, /Would record the client's decision: physical condition = satisfied/);
  assert.match(s, /For information only/);
});

// ───────────────────────────── the deterministic reader ─────────────────────────────

test('the deterministic reader finds the unambiguous lines and leaves the small talk alone', async () => {
  const drafts = await new DeterministicNoteReader().extract({ tenantId: TENANT, matterId: MATTER, text: NOTE, kind: 'call' });
  const kinds = drafts.map((d) => d.command?.type ?? 'none');
  assert.ok(kinds.includes('client_decision_recorded'), JSON.stringify(drafts, null, 2));
  assert.ok(drafts.every((d) => NOTE.includes(d.quote.trim())), 'every quote is verbatim');
  assert.ok(!drafts.some((d) => /daughter/.test(d.summary)), 'small talk is not a case action');
});

test('the deterministic reader does not read a negation as agreement', async () => {
  const drafts = await new DeterministicNoteReader().extract({ tenantId: TENANT, matterId: MATTER, text: 'The client is not happy with the survey at all.', kind: 'typed' });
  assert.equal(drafts.filter((d) => d.command?.type === 'client_decision_recorded').length, 0);
});

// ───────────────────────────── through the machine ─────────────────────────────

test('a note with a document behind it raises one decision carrying every proposal', async () => {
  const h = await enrolled();
  h.ports.noteExtractor = reader([
    { kind: 'client_decision', summary: 'The client is satisfied with the condition', quote: 'She is happy with the damp report', command: { type: 'client_decision_recorded', subject: 'physical_condition', decision: 'satisfied', note: 'happy with the damp report' } },
    { kind: 'issue', summary: 'A boundary point was mentioned', quote: 'the neighbour has put a fence up over the boundary', command: { type: 'raise_issue', kind: 'boundary_discrepancy', title: 'Neighbour has fenced over the boundary', detail: null, gate: 'none' } },
    { kind: 'information', summary: 'Asked after the family', quote: 'Asked after her daughter' },
  ]);
  const documentId = h.doc(null, 'CALL_NOTE');
  const res = await h.svc.recordNote(TENANT, MATTER, { text: NOTE, kind: 'call', actor: USER, documentId });
  const note = Object.values(res.state.notes)[0];
  assert.equal(note.status, 'proposed');
  assert.equal(note.actions.length, 3);
  const pending = blockingDecisions(res.state).filter((d) => d.kind === 'note_actions');
  assert.equal(pending.length, 1, 'one decision, not one per line');
  assert.equal(pending[0].sourceDocumentId, documentId);
  // Nothing is in the case yet.
  assert.deepEqual(res.state.clientDecisions, {});
  assert.deepEqual(Object.keys(res.state.issues), []);
});

test('approving applies each chosen command through the machine\'s ordinary front door', async () => {
  const h = await withSurvey();
  h.ports.noteExtractor = reader([
    { kind: 'client_decision', summary: 'The client is satisfied with the condition', quote: 'She is happy with the damp report', command: { type: 'client_decision_recorded', subject: 'physical_condition', decision: 'satisfied', note: 'happy with the damp report' } },
    { kind: 'issue', summary: 'A boundary point was mentioned', quote: 'the neighbour has put a fence up over the boundary', command: { type: 'raise_issue', kind: 'boundary_discrepancy', title: 'Neighbour has fenced over the boundary', detail: null, gate: 'none' } },
  ]);
  const documentId = h.doc(null, 'CALL_NOTE');
  const recorded = await h.svc.recordNote(TENANT, MATTER, { text: NOTE, kind: 'call', actor: USER, documentId });
  const d = firstDecision(recorded.state, 'note_actions');
  await h.svc.openDecisionSource(TENANT, MATTER, d.eventId, USER);
  await h.svc.resolveDecision(TENANT, MATTER, d.eventId, USER, 'approve');
  const state = await h.svc.getState(TENANT, MATTER);
  assert.equal(state.clientDecisions.physical_condition?.decision, 'satisfied');
  assert.equal(state.survey.status, 'client_satisfied');
  const issue = Object.values(state.issues).find((i) => i.kind === 'boundary_discrepancy');
  assert.ok(issue, 'the boundary point was raised as an issue');
  assert.equal(Object.values(state.notes)[0].status, 'applied');
});

test('a person may apply some lines and not others', async () => {
  const h = await withSurvey();
  h.ports.noteExtractor = reader([
    { kind: 'client_decision', summary: 'The client is satisfied with the condition', quote: 'She is happy with the damp report', command: { type: 'client_decision_recorded', subject: 'physical_condition', decision: 'satisfied', note: '' } },
    { kind: 'issue', summary: 'A boundary point was mentioned', quote: 'the neighbour has put a fence up over the boundary', command: { type: 'raise_issue', kind: 'boundary_discrepancy', title: 'Neighbour has fenced over the boundary', detail: null, gate: 'none' } },
  ]);
  const recorded = await h.svc.recordNote(TENANT, MATTER, { text: NOTE, kind: 'call', actor: USER, documentId: h.doc(null, 'CALL_NOTE') });
  const d = firstDecision(recorded.state, 'note_actions');
  await h.svc.openDecisionSource(TENANT, MATTER, d.eventId, USER);
  await h.svc.resolveDecision(TENANT, MATTER, d.eventId, USER, 'approve', null, null, null, ['A1']);
  const state = await h.svc.getState(TENANT, MATTER);
  assert.equal(state.clientDecisions.physical_condition?.decision, 'satisfied');
  assert.ok(!Object.values(state.issues).some((i) => i.kind === 'boundary_discrepancy'), 'the line nobody chose never happened');
  assert.deepEqual(Object.values(state.notes)[0].appliedActionIds, ['A1']);
});

test('rejecting the reading applies nothing and leaves the note on the file', async () => {
  const h = await withSurvey();
  h.ports.noteExtractor = reader([
    { kind: 'client_decision', summary: 'The client is satisfied with the condition', quote: 'She is happy with the damp report', command: { type: 'client_decision_recorded', subject: 'physical_condition', decision: 'satisfied', note: '' } },
  ]);
  const recorded = await h.svc.recordNote(TENANT, MATTER, { text: NOTE, kind: 'call', actor: USER, documentId: h.doc(null, 'CALL_NOTE') });
  const d = firstDecision(recorded.state, 'note_actions');
  await h.svc.openDecisionSource(TENANT, MATTER, d.eventId, USER);
  await h.svc.resolveDecision(TENANT, MATTER, d.eventId, USER, 'reject', 'That is not what she said.');
  const state = await h.svc.getState(TENANT, MATTER);
  assert.deepEqual(state.clientDecisions, {});
  assert.equal(Object.values(state.notes)[0].status, 'discarded');
  assert.equal(Object.values(state.notes)[0].text, NOTE, 'the note itself is still there');
});

test('approving with nothing selected is refused — reject it with a reason instead', async () => {
  const h = await withSurvey();
  h.ports.noteExtractor = reader([
    { kind: 'client_decision', summary: 'The client is satisfied with the condition', quote: 'She is happy with the damp report', command: { type: 'client_decision_recorded', subject: 'physical_condition', decision: 'satisfied', note: '' } },
  ]);
  const recorded = await h.svc.recordNote(TENANT, MATTER, { text: NOTE, kind: 'call', actor: USER, documentId: h.doc(null, 'CALL_NOTE') });
  const d = firstDecision(recorded.state, 'note_actions');
  await h.svc.openDecisionSource(TENANT, MATTER, d.eventId, USER);
  await assert.rejects(
    () => h.svc.resolveDecision(TENANT, MATTER, d.eventId, USER, 'approve', null, null, null, ['A9']),
    /Nothing was selected/
  );
});

test('a line the machine refuses when it runs is recorded as refused, not as applied', async () => {
  // No survey on the file: the machine will not take the client's view of the condition,
  // and approving the note must not pretend otherwise.
  const h = await enrolled();
  h.ports.noteExtractor = reader([
    { kind: 'client_decision', summary: 'The client is satisfied with the condition', quote: 'She is happy with the damp report', command: { type: 'client_decision_recorded', subject: 'physical_condition', decision: 'satisfied', note: '' } },
  ]);
  const recorded = await h.svc.recordNote(TENANT, MATTER, { text: NOTE, kind: 'call', actor: USER, documentId: h.doc(null, 'CALL_NOTE') });
  const d = firstDecision(recorded.state, 'note_actions');
  await h.svc.openDecisionSource(TENANT, MATTER, d.eventId, USER);
  await h.svc.resolveDecision(TENANT, MATTER, d.eventId, USER, 'approve');
  const note = Object.values((await h.svc.getState(TENANT, MATTER)).notes)[0];
  assert.deepEqual(note.appliedActionIds, []);
  assert.equal(note.refusedActions.length, 1);
  assert.match(note.refusedActions[0].reason, /No survey is on file/);
  assert.equal(note.status, 'discarded');
});

test('a note typed straight into the matter becomes its own evidence, so it can still be decided on', async () => {
  const h = await enrolled();
  h.ports.noteExtractor = reader([
    { kind: 'client_decision', summary: 'The client is satisfied with the condition', quote: 'She is happy with the damp report', command: { type: 'client_decision_recorded', subject: 'physical_condition', decision: 'satisfied', note: '' } },
  ]);
  const res = await h.svc.recordNote(TENANT, MATTER, { text: NOTE, kind: 'typed', actor: USER });
  const note = Object.values(res.state.notes)[0];
  assert.ok(note.documentId, 'the note was filed as a document');
  const d = firstDecision(res.state, 'note_actions');
  assert.equal(d.sourceDocumentId, note.documentId);
  const doc = await h.svc.getDocument(TENANT, MATTER, note.documentId!);
  assert.equal((doc?.extractedFacts as { content: string }).content, NOTE, 'the words on the decision are the words that were filed');
  assert.deepEqual(res.state.clientDecisions, {}, 'still nothing applied');
});

test('if the note cannot be filed as a document it is still on the log, with nothing to approve', async () => {
  const h = await enrolled();
  h.ports.noteExtractor = reader([
    { kind: 'client_decision', summary: 'The client is satisfied with the condition', quote: 'She is happy with the damp report', command: { type: 'client_decision_recorded', subject: 'physical_condition', decision: 'satisfied', note: '' } },
  ]);
  h.ports.documents.createGenerated = async () => { throw new Error('document store down'); };
  const res = await h.svc.recordNote(TENANT, MATTER, { text: NOTE, kind: 'typed', actor: USER });
  assert.equal(Object.values(res.state.notes)[0].text, NOTE);
  assert.equal(Object.values(res.state.notes)[0].actions.length, 1);
  assert.equal(blockingDecisions(res.state).filter((d) => d.kind === 'note_actions').length, 0);
});

test('a note that says nothing about the case raises no decision', async () => {
  const h = await enrolled();
  h.ports.noteExtractor = reader([{ kind: 'information', summary: 'Asked after the family', quote: 'Asked after her daughter' }]);
  const res = await h.svc.recordNote(TENANT, MATTER, { text: NOTE, kind: 'call', actor: USER, documentId: h.doc(null, 'CALL_NOTE') });
  assert.equal(Object.values(res.state.notes)[0].status, 'no_actions');
  assert.equal(blockingDecisions(res.state).filter((d) => d.kind === 'note_actions').length, 0);
});

test('an extractor that falls over leaves the note on the file, unread', async () => {
  const h = await enrolled();
  h.ports.noteExtractor = { name: 'broken', extract: async () => { throw new Error('model unavailable'); } };
  const res = await h.svc.recordNote(TENANT, MATTER, { text: NOTE, kind: 'call', actor: USER, documentId: h.doc(null, 'CALL_NOTE') });
  const note = Object.values(res.state.notes)[0];
  assert.equal(note.text, NOTE);
  assert.equal(note.status, 'no_actions');
});

test('the same note cannot be read twice, and a note needs something in it', async () => {
  const h = await enrolled();
  h.ports.noteExtractor = reader([{ kind: 'information', summary: 'Called the client', quote: 'Spoke to Mrs Okafor at 11:20' }]);
  const res = await h.svc.recordNote(TENANT, MATTER, { text: NOTE, kind: 'call', actor: USER });
  const noteId = Object.values(res.state.notes)[0].id;
  await assert.rejects(() => h.svc.run(TENANT, MATTER, { type: 'note_extracted', noteId, drafts: [], extractor: 'x' }), /already been read/);
  await assert.rejects(() => h.svc.recordNote(TENANT, MATTER, { text: 'ok', kind: 'typed', actor: USER }), /needs something in it/);
});

test('a note is filed under the person who took it — automation cannot record one', async () => {
  const h = await enrolled();
  await assert.rejects(
    () => h.svc.run(TENANT, MATTER, { type: 'record_note', actor: 'system', kind: 'typed', text: NOTE } as never),
    /filed under the name of the person/
  );
});

test('every action carried on the decision quotes the note it came from', async () => {
  const h = await enrolled();
  h.ports.noteExtractor = new DeterministicNoteReader();
  const res = await h.svc.recordNote(TENANT, MATTER, { text: NOTE, kind: 'call', actor: USER, documentId: h.doc(null, 'CALL_NOTE') });
  const actions: NoteAction[] = Object.values(res.state.notes)[0].actions;
  assert.ok(actions.length > 0);
  for (const a of actions) assert.ok(NOTE.includes(a.quote.trim()), `not verbatim: ${a.quote}`);
});
