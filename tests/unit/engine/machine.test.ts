import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, stageBlockers, assertCanSendReport } from '../../../lib/server/engine/machine';
import { project } from '../../../lib/server/engine/projection';
import { initialState, EngineError, type EngineEvent, type NewEvent } from '../../../lib/server/engine/types';
import { harness, resolve, firstDecision, TENANT, MATTER, USER, SENIOR, idClear, searchClear, searchFlagged, titleClear, offerClear } from './helpers';

const now = new Date('2026-09-14T09:00:00Z');

/** Apply a list of commands to a fresh in-memory log using the pure machine only. */
function runPure(cmds: Parameters<typeof decide>[1][]) {
  let log: EngineEvent[] = [];
  let state = initialState(TENANT, MATTER);
  for (const c of cmds) {
    const { events } = decide(state, c, { now });
    const appended = events.map((e, i) => ({ ...e, id: `e${log.length + i + 1}`, tenantId: TENANT, matterId: MATTER, seq: log.length + i + 1, createdAt: now.toISOString() }) as EngineEvent);
    log = [...log, ...appended];
    state = project(TENANT, MATTER, log);
  }
  return { log, state };
}

test('enrolment starts at instruction with the required searches', () => {
  const { state, log } = runPure([{ type: 'enrol', actor: USER, hasLender: true }]);
  assert.equal(state.stage, 'instruction');
  assert.deepEqual(state.requiredSearches, ['LLC1', 'CON29', 'DRAINAGE_WATER', 'ENVIRONMENTAL']);
  assert.equal(log[0].type, 'matter_created');
  assert.deepEqual(stageBlockers(state), ['ID/AML check not started']);
  assert.throws(() => decide(state, { type: 'enrol', actor: USER, hasLender: true }, { now }), EngineError);
});

test('every transition is automation or a decision — nothing else', () => {
  const { log } = runPure([
    { type: 'enrol', actor: USER, hasLender: false },
    { type: 'request_id_check', actor: USER, provider: 'p' },
    { type: 'id_check_result', actor: 'external', documentId: 'd1', facts: idClear() },
  ]);
  for (const e of log) assert.ok(['system', 'ai', 'external', USER].includes(e.actor), `${e.type} by ${e.actor}`);
  assert.equal(log.at(-1)?.type, 'stage_advanced');
});

test('search sub-flow: ordered → returned → extracted → cleared, and the stage gate holds until ALL required searches resolve', () => {
  const base: NewEvent[] = [];
  void base;
  const { state } = runPure([
    { type: 'enrol', actor: USER, hasLender: false, requiredSearches: ['LLC1', 'CON29'] },
    { type: 'request_id_check', actor: USER, provider: 'p' },
    { type: 'id_check_result', actor: 'external', documentId: 'd1', facts: idClear() },
    { type: 'record_search_ordered', actor: 'system', searchType: 'LLC1', provider: 'mock' },
    { type: 'record_search_ordered', actor: 'system', searchType: 'CON29', provider: 'mock' },
    { type: 'search_returned', actor: 'external', searchType: 'LLC1', documentId: 'd-llc1' },
    { type: 'search_extracted', actor: 'system', searchType: 'LLC1', facts: searchClear('LLC1'), extractor: 'fixture' },
  ]);
  assert.equal(state.stage, 'pre_contract');
  assert.equal(state.searches.LLC1.status, 'cleared');
  assert.equal(state.searches.CON29.status, 'ordered');
  assert.deepEqual(stageBlockers(state), ['CON29 search ordered']);
  assert.equal(state.waits.filter((w) => w.closedAt === null).map((w) => w.subject).join(), 'CON29');
});

test('search cannot be returned before it is ordered, nor extracted twice', () => {
  const { state } = runPure([
    { type: 'enrol', actor: USER, hasLender: false },
    { type: 'request_id_check', actor: USER, provider: 'p' },
    { type: 'id_check_result', actor: 'external', documentId: 'd1', facts: idClear() },
  ]);
  assert.throws(() => decide(state, { type: 'search_returned', actor: 'external', searchType: 'LLC1', documentId: 'x' }, { now }), /never ordered/);
  assert.throws(() => decide(state, { type: 'search_extracted', actor: 'system', searchType: 'LLC1', facts: searchClear('LLC1'), extractor: 'f' }, { now }), /not awaiting extraction/);
});

test('flagged search creates a decision that cites the search PDF; resolving requires opening it; approve resolves the sub-flow', () => {
  const { state } = runPure([
    { type: 'enrol', actor: USER, hasLender: false, requiredSearches: ['CON29'] },
    { type: 'request_id_check', actor: USER, provider: 'p' },
    { type: 'id_check_result', actor: 'external', documentId: 'd1', facts: idClear() },
    { type: 'record_search_ordered', actor: 'system', searchType: 'CON29', provider: 'mock' },
    { type: 'search_returned', actor: 'external', searchType: 'CON29', documentId: 'd-con29' },
    { type: 'search_extracted', actor: 'system', searchType: 'CON29', facts: searchFlagged('CON29'), extractor: 'fixture' },
  ]);
  const d = firstDecision(state);
  assert.equal(d.kind, 'search');
  assert.equal(d.status, 'pending');
  assert.equal(d.sourceDocumentId, 'd-con29');
  assert.equal(state.searches.CON29.status, 'flagged');

  assert.throws(() => decide(state, { type: 'resolve_decision', userId: USER, decisionEventId: d.eventId, option: 'approve' }, { now }), /Open the source document/);
  assert.throws(() => decide(state, { type: 'open_decision_source', userId: USER, decisionEventId: d.eventId, documentId: 'other' }, { now }), /not the source/);
  assert.throws(() => decide(state, { type: 'resolve_decision', userId: 'system', decisionEventId: d.eventId, option: 'approve' }, { now }), /people/);

  const opened = decide(state, { type: 'open_decision_source', userId: USER, decisionEventId: d.eventId, documentId: 'd-con29' }, { now }).state;
  // A different user still has to open it themselves.
  assert.throws(() => decide(opened, { type: 'resolve_decision', userId: SENIOR, decisionEventId: d.eventId, option: 'approve' }, { now }), /Open the source/);
  const after = decide(opened, { type: 'resolve_decision', userId: USER, decisionEventId: d.eventId, option: 'approve', note: 'Enforcement notice withdrawn per LA letter' }, { now });
  assert.equal(after.events[0].type, 'search_reviewed');
  assert.equal(after.events[0].actor, USER);
  assert.equal(after.state.searches.CON29.status, 'reviewed');
  assert.equal(after.state.decisions[d.eventId].status, 'actioned');
  assert.equal(after.state.stage, 'contract_review'); // the only required search is now resolved
});

test('request_further raises a tracked follow-up enquiry that gates the stage', () => {
  const { state } = runPure([
    { type: 'enrol', actor: USER, hasLender: false, requiredSearches: ['CON29'] },
    { type: 'request_id_check', actor: USER, provider: 'p' },
    { type: 'id_check_result', actor: 'external', documentId: 'd1', facts: idClear() },
    { type: 'record_search_ordered', actor: 'system', searchType: 'CON29', provider: 'mock' },
    { type: 'search_returned', actor: 'external', searchType: 'CON29', documentId: 'd-con29' },
    { type: 'search_extracted', actor: 'system', searchType: 'CON29', facts: searchFlagged('CON29'), extractor: 'fixture' },
  ]);
  const d = firstDecision(state);
  const opened = decide(state, { type: 'open_decision_source', userId: USER, decisionEventId: d.eventId, documentId: 'd-con29' }, { now }).state;
  const after = decide(opened, { type: 'resolve_decision', userId: USER, decisionEventId: d.eventId, option: 'request_further', note: 'Need the LA enforcement file before advising' }, { now });
  assert.deepEqual(after.events.map((e) => e.type), ['search_reviewed', 'enquiry_raised']);
  assert.equal(after.state.stage, 'pre_contract');
  assert.match(stageBlockers(after.state)[0], /enquiry SEARCH-F1 raised/);
});

test('escalate hands the same source to a senior; resolving the escalation resolves the original', () => {
  const { state } = runPure([
    { type: 'enrol', actor: USER, hasLender: false, requiredSearches: ['CON29'] },
    { type: 'request_id_check', actor: USER, provider: 'p' },
    { type: 'id_check_result', actor: 'external', documentId: 'd1', facts: idClear() },
    { type: 'record_search_ordered', actor: 'system', searchType: 'CON29', provider: 'mock' },
    { type: 'search_returned', actor: 'external', searchType: 'CON29', documentId: 'd-con29' },
    { type: 'search_extracted', actor: 'system', searchType: 'CON29', facts: searchFlagged('CON29'), extractor: 'fixture' },
  ]);
  const d = firstDecision(state);
  let s = decide(state, { type: 'open_decision_source', userId: USER, decisionEventId: d.eventId, documentId: 'd-con29' }, { now }).state;
  const esc = decide(s, { type: 'resolve_decision', userId: USER, decisionEventId: d.eventId, option: 'escalate', note: 'Not sure this is standard' }, { now });
  assert.deepEqual(esc.events.map((e) => e.type), ['search_reviewed', 'escalation_raised']);
  s = esc.state;
  assert.equal(s.decisions[d.eventId].status, 'escalated');
  assert.equal(s.searches.CON29.status, 'flagged'); // still unresolved
  const escId = Object.values(s.decisions).find((x) => x.kind === 'escalation')!.eventId;
  assert.equal(s.decisions[escId].sourceDocumentId, 'd-con29');
  s = decide(s, { type: 'open_decision_source', userId: SENIOR, decisionEventId: escId, documentId: 'd-con29' }, { now }).state;
  const done = decide(s, { type: 'resolve_decision', userId: SENIOR, decisionEventId: escId, option: 'approve' }, { now });
  assert.deepEqual(done.events.map((e) => e.type), ['escalation_resolved', 'search_reviewed', 'stage_advanced']);
  assert.equal(done.state.searches.CON29.status, 'reviewed');
  assert.equal(done.state.searches.CON29.resolution, 'approve');
});

test('report on title: never sent without a human approval event; rejection allows a redraft', () => {
  const { state } = runPure([
    { type: 'enrol', actor: USER, hasLender: false, requiredSearches: ['CON29'] },
    { type: 'request_id_check', actor: USER, provider: 'p' },
    { type: 'id_check_result', actor: 'external', documentId: 'd1', facts: idClear() },
    { type: 'record_search_ordered', actor: 'system', searchType: 'CON29', provider: 'mock' },
    { type: 'search_returned', actor: 'external', searchType: 'CON29', documentId: 'd-con29' },
    { type: 'search_extracted', actor: 'system', searchType: 'CON29', facts: searchClear('CON29'), extractor: 'fixture' },
    { type: 'title_extracted', actor: 'system', documentId: 'd-title', facts: titleClear(), extractor: 'fixture' },
  ]);
  assert.equal(state.stage, 'contract_review');
  const draftCmd = { type: 'draft_report_on_title' as const, draftId: 'rot-1', draftDocumentId: 'd-rot', model: 'template', summary: 'Draft ready', citations: [{ documentId: 'd-title', label: 'Title' }] };
  const drafted = decide(state, draftCmd, { now }).state;
  assert.equal(drafted.reportOnTitle.status, 'drafted');
  assert.throws(() => assertCanSendReport(drafted, 'rot-1'), /not been approved/);
  assert.throws(() => decide(drafted, { type: 'record_report_on_title_sent', actor: 'system', draftId: 'rot-1', channel: 'mock' }, { now }), /not been approved/);
  assert.throws(() => decide(drafted, draftCmd, { now }), /already awaiting approval/);

  const decisionId = Object.values(drafted.decisions).find((d) => d.kind === 'report_on_title')!.eventId;
  let s = decide(drafted, { type: 'open_decision_source', userId: USER, decisionEventId: decisionId, documentId: 'd-rot' }, { now }).state;
  const rejected = decide(s, { type: 'resolve_decision', userId: USER, decisionEventId: decisionId, option: 'reject', note: 'Missing covenant wording' }, { now });
  assert.equal(rejected.events[0].type, 'report_on_title_rejected');
  assert.equal(rejected.state.reportOnTitle.status, 'rejected');
  // Redraft, approve, send.
  s = decide(rejected.state, { ...draftCmd, draftId: 'rot-2', draftDocumentId: 'd-rot2' }, { now }).state;
  const id2 = Object.values(s.decisions).find((d) => d.kind === 'report_on_title' && d.status === 'pending')!.eventId;
  s = decide(s, { type: 'open_decision_source', userId: USER, decisionEventId: id2, documentId: 'd-rot2' }, { now }).state;
  s = decide(s, { type: 'resolve_decision', userId: USER, decisionEventId: id2, option: 'approve' }, { now }).state;
  assert.equal(s.reportOnTitle.status, 'approved');
  assert.equal(s.reportOnTitle.approvedBy, USER);
  assert.throws(() => decide(s, { type: 'record_report_on_title_sent', actor: 'system', draftId: 'rot-1', channel: 'mock' }, { now }), /not the current/);
  const sent = decide(s, { type: 'record_report_on_title_sent', actor: 'system', draftId: 'rot-2', channel: 'mock' }, { now });
  assert.deepEqual(sent.events.map((e) => e.type), ['report_on_title_sent', 'stage_advanced']);
  assert.equal(sent.state.stage, 'pre_exchange');
  assert.equal((sent.events[0] as EngineEvent<'report_on_title_sent'>).payload.approvedEventId, s.reportOnTitle.approvedEventId);
});

test('leasehold title halts automation for manual handling', () => {
  const { state } = runPure([
    { type: 'enrol', actor: USER, hasLender: false, requiredSearches: ['CON29'] },
    { type: 'request_id_check', actor: USER, provider: 'p' },
    { type: 'id_check_result', actor: 'external', documentId: 'd1', facts: idClear() },
    { type: 'title_extracted', actor: 'system', documentId: 'd-title', facts: { ...titleClear(), tenure: 'leasehold' }, extractor: 'fixture' },
  ]);
  assert.equal(state.manualHandling.required, true);
  assert.equal(state.manualHandling.reason, 'leasehold_unsupported');
  assert.deepEqual(stageBlockers(state), ['manual handling: leasehold_unsupported']);
});

test('exchange and completion ordering invariants', () => {
  const { state } = runPure([
    { type: 'enrol', actor: USER, hasLender: true, requiredSearches: ['CON29'] },
    { type: 'request_id_check', actor: USER, provider: 'p' },
    { type: 'id_check_result', actor: 'external', documentId: 'd1', facts: idClear() },
  ]);
  assert.throws(() => decide(state, { type: 'contracts_exchanged', actor: USER, completionDate: '2026-11-20' }, { now }), /only valid at stage "pre_exchange"/);
  assert.throws(() => decide(state, { type: 'completion_confirmed', actor: USER }, { now }), /only valid at stage "pre_completion"/);
  assert.throws(() => decide(state, { type: 'sdlt_submitted', actor: USER }, { now }), /not valid before stage "completed"/);
  assert.throws(() => decide(state, { type: 'mortgage_offer_extracted', actor: 'system', facts: offerClear(), extractor: 'f' }, { now }), /No mortgage offer/);
});

test('in-memory service: concurrent commands on one matter serialise without losing events', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: false });
  await Promise.all([
    h.svc.run(TENANT, MATTER, { type: 'raise_enquiry', actor: USER, enquiryId: 'A', subject: 'a' }).catch(() => null),
    h.svc.run(TENANT, MATTER, { type: 'raise_enquiry', actor: USER, enquiryId: 'B', subject: 'b' }).catch(() => null),
  ]).catch(() => {});
  // raise_enquiry needs pre_contract; both should have been rejected cleanly, log intact and gap-free.
  const log = h.store.dump(TENANT, MATTER);
  assert.deepEqual(log.map((e) => e.seq), log.map((_, i) => i + 1));
});

test('resolve() helper enforces the open-source precondition end to end', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, hasLender: false, requiredSearches: ['CON29'] });
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  await h.svc.idCheckResultReceived(TENANT, MATTER, h.doc(idClear()));
  const con29 = h.doc(searchFlagged('CON29'));
  const r = await h.svc.searchReturned(TENANT, MATTER, 'CON29', con29);
  const d = firstDecision(r.state);
  await assert.rejects(h.svc.resolveDecision(TENANT, MATTER, d.eventId, USER, 'approve'), /Open the source/);
  const after = await resolve(h, d.eventId, 'approve');
  assert.equal(after.state.searches.CON29.status, 'reviewed');
});
