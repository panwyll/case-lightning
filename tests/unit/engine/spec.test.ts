/**
 * The spec (what the map shows) must match the machine (what the code does). Any drift —
 * a new event, command, option or SLA number without its line in spec.ts, or a spec line
 * with no code behind it — fails here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { machineSpec, COMMAND_SPECS, STAGE_SPECS, SUBFLOW_SPECS } from '../../../lib/server/engine/spec';
import { decide, stageBlockers, USER_COMMANDS } from '../../../lib/server/engine/machine';
import { DEFAULT_SLA, DEADLINE_LEAD } from '../../../lib/server/engine/sla';
import { OPTIONS_FOR } from '../../../lib/server/engine/rules';
import { EVENT_TYPES, STAGES, SUB_FLOWS, DECISION_KINDS, initialState, type Stage } from '../../../lib/server/engine/types';
import { TRIGGERS } from '../../../lib/server/engine/triggers';
import { harness, resolve, firstDecision, TENANT, MATTER, USER, idClear, searchClear, titleClear } from './helpers';

const spec = machineSpec();

test('spec: stages, sub-flows, events, decisions and options are exactly the machine\'s', () => {
  assert.deepEqual(spec.stages.map((s) => s.id), [...STAGES], 'stage order');
  assert.deepEqual(new Set(spec.subflows.map((s) => s.id)), new Set(SUB_FLOWS));
  assert.deepEqual(new Set(spec.events.map((e) => e.type)), new Set(EVENT_TYPES));
  assert.deepEqual(new Set(spec.decisions.map((d) => d.kind)), new Set(DECISION_KINDS));
  for (const d of spec.decisions) assert.deepEqual(d.options, OPTIONS_FOR[d.kind], `options for ${d.kind}`);
  for (const sf of SUBFLOW_SPECS) {
    for (const ev of [...sf.start, sf.extracted, sf.cleared, sf.flagged, sf.reviewed].filter(Boolean)) assert.ok(EVENT_TYPES.includes(ev as never), `${sf.id}: ${ev} is a real event`);
    if (sf.decisionKind) assert.ok(DECISION_KINDS.includes(sf.decisionKind));
  }
  for (const st of STAGE_SPECS) for (const sf of st.subflows) assert.ok(SUB_FLOWS.includes(sf));
});

test('spec: every user command has a spec entry with the right actor; every emitted event exists; every stage list is valid', () => {
  const byType = new Map(COMMAND_SPECS.map((c) => [c.type, c]));
  for (const c of USER_COMMANDS) {
    const s = byType.get(c);
    assert.ok(s, `spec for user command ${c}`);
    assert.notEqual(s!.actor, 'automation', `${c} is issued by people`);
  }
  for (const c of COMMAND_SPECS) {
    for (const e of c.emits) assert.ok(EVENT_TYPES.includes(e), `${c.type} emits ${e}`);
    if (Array.isArray(c.stages)) for (const st of c.stages) assert.ok(STAGES.includes(st), `${c.type} stage ${st}`);
    if (!USER_COMMANDS.includes(c.type)) assert.ok(c.actor === 'automation' || c.type === 'set_shadow_mode' || c.type === 'record_report_on_title_sent' || c.type === 'open_decision_source' || c.type === 'resolve_decision', `${c.type} is automation or a service-level human step`);
  }
  // Human-gated events are the three the database trigger guards.
  assert.deepEqual(spec.events.filter((e) => e.humanGated).map((e) => e.type).sort(), ['funds_requested', 'payment_authorised', 'report_on_title_sent']);
  assert.deepEqual(COMMAND_SPECS.filter((c) => c.humanGated).map((c) => c.type).sort(), ['funds_requested', 'payment_authorised', 'record_report_on_title_sent']);
});

test('spec: timers mirror DEFAULT_SLA and DEADLINE_LEAD exactly', () => {
  for (const w of spec.timers.waits) {
    const r = DEFAULT_SLA[w.waitKey];
    assert.deepEqual([w.chaseAfter, w.chaseEvery, w.escalateAfter, w.reEscalateAfter, w.recipientRole, w.template], [r.chaseAfter, r.chaseEvery, r.escalateAfter, r.reEscalateAfter, r.recipientRole, r.template]);
  }
  assert.deepEqual(Object.fromEntries(spec.timers.deadlines.map((d) => [d.kind, d.leadWorkingDays])), DEADLINE_LEAD);
});

test('spec: each stage\'s gates are what stageBlockers reports on a bare state at that stage', () => {
  for (const st of STAGE_SPECS) {
    const s = { ...initialState(TENANT, MATTER), enrolled: true, hasLender: true, requiredSearches: ['CON29' as const], stage: st.id as Stage };
    const blockers = stageBlockers(s).join(' | ').toLowerCase();
    for (const kw of st.gateKeywords) assert.ok(blockers.includes(kw.toLowerCase()), `${st.id}: blockers "${blockers}" mention "${kw}"`);
    assert.ok(st.gates.length > 0);
  }
});

test('spec: the stage spine is reachable in order by running the machine end to end; command stage lists agree with the machine\'s refusals', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, requireProofOfFunds: false, requireExchangeAuthority: false, hasLender: false, requiredSearches: ['CON29'] });
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  await h.svc.idCheckResultReceived(TENANT, MATTER, h.doc(idClear()));
  await h.svc.searchReturned(TENANT, MATTER, 'CON29', h.doc(searchClear('CON29')));
  await h.svc.titleReceived(TENANT, MATTER, h.doc(titleClear()));
  await h.svc.draftReportOnTitle(TENANT, MATTER);
  await resolve(h, firstDecision(await h.svc.getState(TENANT, MATTER), 'report_on_title').eventId, 'approve');
  await h.svc.sendReportOnTitle(TENANT, MATTER, USER);
  await h.svc.run(TENANT, MATTER, { type: 'deposit_received', actor: USER });
  await h.svc.run(TENANT, MATTER, { type: 'contracts_exchanged', actor: USER, completionDate: '2026-12-11' });
  await h.svc.run(TENANT, MATTER, { type: 'completion_statement_generated', actor: USER });
  const moves = h.store.dump(TENANT, MATTER).filter((e) => e.type === 'stage_advanced').map((e) => (e.payload as { to: string }).to);
  assert.deepEqual(moves, ['pre_contract', 'contract_review', 'pre_exchange', 'exchanged', 'pre_completion'], 'the first five transitions in spec order');
  // A command whose spec says "only at stage X" is refused elsewhere: sample the stage-bound ones against a bare state.
  for (const c of COMMAND_SPECS.filter((x) => Array.isArray(x.stages) && x.stages.length === 1)) {
    const wrong = STAGES.find((st) => !(c.stages as Stage[]).includes(st))!;
    const s = { ...initialState(TENANT, MATTER), enrolled: true, hasLender: true, requiredSearches: [], stage: wrong };
    const probe = { type: c.type, actor: USER, completionDate: '2026-12-11', fromRole: 'client', bankDetailsId: 'x', draftId: 'd', draftDocumentId: 'doc', model: 'm', summary: 's', citations: [], documentId: 'doc', servedBy: 'seller', expiresAt: '2027-01-01' } as never;
    if (c.type === 'record_report_on_title_sent') continue; // asserted through assertCanSendReport, not a stage message
    assert.throws(() => decide(s, probe, { now: new Date() }), (e: Error) => /stage|not valid|only valid|exchanged|AP1|already/i.test(e.message), `${c.type} refused at ${wrong}: ${(() => { try { decide(s, probe, { now: new Date() }); return 'accepted'; } catch (e) { return (e as Error).message; } })()}`);
  }
});

test('spec: triggers reference real sub-flows / commands; the spec version changes when the spec changes', () => {
  const known = new Set<string>([...SUB_FLOWS, ...COMMAND_SPECS.map((c) => c.type), 'USER_COMMANDS']);
  for (const t of TRIGGERS) for (const r of t.reaches) assert.ok(known.has(r), `${t.id} reaches ${r}`);
  assert.match(spec.version, /^[0-9a-f]{12}$/);
  assert.equal(machineSpec().version, spec.version, 'deterministic');
});

test('docs/engine-map.md is the current machine (regenerate with `npm run engine:map` when the spec changes)', () => {
  const fs = require('node:fs') as typeof import('node:fs');
  const md = fs.readFileSync('docs/engine-map.md', 'utf8');
  const v = machineSpec().version;
  assert.ok(md.includes(`Spec version \`${v}\``), `docs/engine-map.md was generated from spec ${(md.match(/Spec version `([0-9a-f]+)`/) ?? [])[1]} but the machine is ${v} — run: npm run engine:map`);
});
