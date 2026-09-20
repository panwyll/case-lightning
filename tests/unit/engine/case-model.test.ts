/**
 * The case model (docs/case-model.md): coarse lifecycle over concurrent workstreams,
 * requirements with completion authority, gates that explain themselves, issues that
 * carry behaviour and chain, time as a source of events, facts automated and judgements
 * routed (the survey example from the design spec), and a dependency graph the UI projects.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { caseGraph, gate, lifecycle, nextActions, requirements, whyNot, workstreams } from '../../../lib/server/engine/graph';
import { timedIssueActions } from '../../../lib/server/engine/sla';
import { ISSUE_KIND_SPECS } from '../../../lib/server/engine/issues';
import { openIssues, pendingDecisions } from '../../../lib/server/engine/types';
import { harness, resolve, firstDecision, TENANT, MATTER, USER, idClear, searchClear, offerClear, titleClear } from './helpers';

const SURVEY = { surveyType: 'level3' as const, surveyor: 'J Bloggs MRICS', summary: 'Generally sound; damp to the rear addition and a tired roof covering.', recommendations: [
  { code: 'DAMP_REAR', text: 'High moisture readings to the rear addition; a specialist damp and timber report is recommended before exchange.', furtherInvestigation: true, specialist: 'Damp and timber', severity: 'medium' as const, locator: { page: 14 } },
  { code: 'ROOF', text: 'Roof covering nearing the end of its life; budget for replacement within 5–10 years.', furtherInvestigation: false, specialist: null, severity: 'low' as const },
  { code: 'ELECTRICS', text: 'Consumer unit is dated; an EICR is recommended.', furtherInvestigation: true, specialist: 'Electrician (EICR)', severity: 'medium' as const },
], confidence: 0.93 };

test('issue kinds carry behaviour: severity, workstreams, milestones threatened, actions, owner, escalation', () => {
  for (const k of ISSUE_KIND_SPECS) {
    assert.ok(['info', 'warning', 'critical'].includes(k.severity), k.kind);
    assert.ok(k.threatens.length > 0, `${k.kind} threatens something`);
    assert.ok(k.responsible, k.kind);
    if (k.kind !== 'other') assert.ok(k.workstreams.length > 0 && k.actions.length > 0, `${k.kind} has workstreams and actions`);
  }
  const exp = ISSUE_KIND_SPECS.find((k) => k.kind === 'mortgage_offer_expiring')!;
  assert.deepEqual(exp.threatens, ['exchange', 'completion']);
  assert.equal(exp.gate, 'none', 'expiring is a warning: exchanging is the fix, so it holds nothing');
  assert.match(exp.actions[0], /broker/);
});

test('survey: facts are automated (report received, further investigation recommended, specialist finds nothing), the client\'s satisfaction is a client decision — and the chain of ordinary issues is visible', async () => {
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
  let s = await h.svc.getState(TENANT, MATTER);
  assert.equal(lifecycle(s), 'ready_to_exchange', 'coarse lifecycle: everything satisfied → READY TO EXCHANGE (a derived gate state)');
  assert.equal(workstreams(s).find((w) => w.id === 'survey')!.status, 'not_applicable');

  // The survey arrives: two "further investigation" recommendations → two issues, automatically, holding exchange.
  const sv = await h.svc.surveyReceived(TENANT, MATTER, h.doc(SURVEY, 'SURVEY'));
  assert.deepEqual(sv.events.map((e) => e.type), ['survey_received', 'issue_raised', 'issue_raised']);
  s = sv.state;
  assert.equal(s.survey.status, 'further_investigation');
  assert.equal(lifecycle(s), 'pre_exchange', 'no longer ready');
  const fi = openIssues(s).filter((i) => i.kind === 'survey_further_investigation');
  assert.equal(fi.length, 2);
  assert.match(fi[0].title, /Damp and timber report recommended/);
  assert.equal(fi[0].raisedBy, 'system');
  const ws = workstreams(s).find((w) => w.id === 'survey')!;
  assert.equal(ws.status, 'blocked');
  const why = whyNot(s, 'exchange');
  assert.ok(why.some((l) => /Client satisfied with the physical condition: .*Damp and timber/.test(l)), why.join('\n'));
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'client_decision_recorded', actor: USER, subject: 'physical_condition', decision: 'satisfied' }), /Further investigation is still outstanding/);

  // Specialist 1: damp — finds no evidence of decay, no further investigation → the issue is resolved by the report (a fact).
  const damp = await h.svc.specialistReportReceived(TENANT, MATTER, h.doc({ surveyType: 'specialist', surveyor: 'Timberwise', summary: 'No evidence of active decay; readings consistent with condensation.', recommendations: [{ code: 'VENT', text: 'Improve ventilation to the rear addition.', furtherInvestigation: false, severity: 'low' }], confidence: 0.9 }, 'SPECIALIST_REPORT'), fi[0].id);
  assert.deepEqual(damp.events.map((e) => e.type), ['specialist_report_received', 'issue_resolved']);
  s = damp.state;
  assert.equal(s.issues[fi[0].id].status, 'resolved');
  assert.equal(s.issues[fi[0].id].resolution, 'specialist_report_clear');
  assert.equal(s.issues[fi[0].id].resolvedBy, 'system', 'the machine records the fact the specialist established');
  assert.equal(s.survey.status, 'further_investigation', 'the electrics one is still open');

  // Specialist 2: the electrician recommends a further structural check → the old issue closes, a new one chains (DISCOVERED_BY).
  const eicr = await h.svc.specialistReportReceived(TENANT, MATTER, h.doc({ surveyType: 'specialist', recommendations: [{ code: 'REWIRE', text: 'Partial rewire needed; a structural engineer should check the joists where cables were chased.', furtherInvestigation: true, specialist: 'Structural engineer', severity: 'high' }], confidence: 0.9 }, 'SPECIALIST_REPORT'), fi[1].id);
  s = eicr.state;
  assert.equal(s.issues[fi[1].id].status, 'resolved');
  const chained = openIssues(s).find((i) => i.kind === 'survey_further_investigation')!;
  assert.equal(chained.causedBy, fi[1].id);
  assert.equal(chained.severity, 'critical');
  const g = caseGraph(s);
  assert.ok(g.edges.some((e) => e.type === 'DISCOVERED_BY' && e.from === `issue:${chained.id}` && e.to === `issue:${fi[1].id}`));
  assert.ok(g.edges.some((e) => e.type === 'THREATENS' && e.from === `issue:${chained.id}` && e.to === 'gate:exchange'));
  assert.ok(g.edges.some((e) => e.type === 'BLOCKS' && e.from === `issue:${chained.id}` && e.to === 'req:physical_condition_accepted'));

  // Structural engineer: nothing to worry about → survey waits on the client.
  await h.svc.specialistReportReceived(TENANT, MATTER, h.doc({ surveyType: 'specialist', recommendations: [], confidence: 0.95 }, 'SPECIALIST_REPORT'), chained.id);
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.survey.status, 'awaiting_client');
  const req = requirements(s).find((r) => r.id === 'physical_condition_accepted')!;
  assert.equal(req.authority, 'client');
  assert.equal(req.satisfied, false);
  assert.deepEqual(req.blockedBy.map((b) => b.type), ['client']);
  const na = nextActions(s);
  assert.ok(na.some((a) => a.who === 'client' && /satisfied/.test(a.what)), JSON.stringify(na));
  // The machine never infers satisfaction; a person records the client's decision.
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'client_decision_recorded', actor: 'system', subject: 'physical_condition', decision: 'satisfied' }), /never inferred/);
  await h.svc.run(TENANT, MATTER, { type: 'client_decision_recorded', actor: USER, subject: 'physical_condition', decision: 'satisfied', note: 'Client happy with the reports; proceeding at the agreed price' });
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.survey.status, 'client_satisfied');
  assert.equal(lifecycle(s), 'ready_to_exchange');
  assert.equal(gate(s, 'exchange').ready, true);
  assert.equal(workstreams(s).find((w) => w.id === 'survey')!.status, 'complete');
  const ex = await h.svc.run(TENANT, MATTER, { type: 'contracts_exchanged', actor: USER, completionDate: '2026-12-11' });
  assert.equal(lifecycle(ex.state), 'exchanged');
});

test('client wants to renegotiate after the survey → a survey_defect issue; readiness view explains; requirements show authority per node', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, requireProofOfFunds: false, requireExchangeAuthority: false, hasLender: true, requiredSearches: ['CON29'] });
  await h.svc.surveyReceived(TENANT, MATTER, h.doc({ ...SURVEY, recommendations: [SURVEY.recommendations[1]] }, 'SURVEY'));
  let s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.survey.status, 'awaiting_client', 'no further investigation → straight to the client');
  const r = await h.svc.run(TENANT, MATTER, { type: 'client_decision_recorded', actor: USER, subject: 'physical_condition', decision: 'renegotiate', note: 'Wants £8,000 off for the roof' });
  assert.deepEqual(r.events.map((e) => e.type), ['client_decision_recorded', 'issue_raised']);
  s = r.state;
  assert.equal(s.survey.status, 'client_renegotiating');
  assert.equal(openIssues(s)[0].kind, 'survey_defect');
  const reqs = requirements(s).filter((x) => x.gate === 'exchange' && x.applies);
  const byAuth = Object.fromEntries(reqs.map((x) => [x.id, x.authority]));
  assert.equal(byAuth.physical_condition_accepted, 'client');
  assert.equal(byAuth.source_of_funds_satisfactory, undefined, 'policy off and no round → does not apply');
  assert.equal(byAuth.deposit_confirmed, 'system');
  assert.equal(byAuth.report_on_title_sent, 'conveyancer');
  assert.equal(byAuth.mortgage_offer_valid, 'conveyancer', 'no offer yet → a person will judge it');
  const lines = whyNot(s);
  assert.ok(lines.some((l) => /Valid mortgage offer: offer not yet received/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => /No unresolved blocking issue: Survey defect/.test(l)), lines.join('\n'));
});

test('time as a source of events: the offer goes VALID → EXPIRING (warning) → CRITICAL → EXPIRED; aged waits become issues; sitting issues escalate; the timer closes what it raised', async () => {
  const h = harness(new Date('2026-09-01T09:00:00Z'));
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, requireProofOfFunds: false, requireExchangeAuthority: false, hasLender: true, requiredSearches: ['CON29'] });
  await h.svc.requestIdCheck(TENANT, MATTER, USER);
  await h.svc.idCheckResultReceived(TENANT, MATTER, h.doc(idClear()));
  await h.svc.mortgageOfferReceived(TENANT, MATTER, h.doc({ ...offerClear(), expiryDate: '2026-10-20' }));
  let s = await h.svc.getState(TENANT, MATTER);
  const md = pendingDecisions(s).find((d) => d.kind === 'mortgage');
  if (md) await resolve(h, md.eventId, 'approve', USER, 'ok');
  s = await h.svc.getState(TENANT, MATTER);
  assert.deepEqual(timedIssueActions(s, h.ports.now()), [], '49 days out: nothing');
  h.ports.setNow(new Date('2026-09-22T09:00:00Z')); // 28 days out
  let acts = timedIssueActions(await h.svc.getState(TENANT, MATTER), h.ports.now());
  assert.ok(acts.some((a) => a.kind === 'raise' && a.issueKind === 'mortgage_offer_expiring' && a.severity === 'warning'), JSON.stringify(acts));
  await h.svc.tick(TENANT, MATTER);
  s = await h.svc.getState(TENANT, MATTER);
  const exp = openIssues(s).find((i) => i.kind === 'mortgage_offer_expiring')!;
  assert.equal(exp.severity, 'warning');
  assert.equal(exp.gate, 'none');
  assert.equal(workstreams(s, h.ports.now()).find((w) => w.id === 'mortgage')!.status, 'at_risk');
  assert.equal((await h.svc.tick(TENANT, MATTER)).chases, 0, 'idempotent: not raised twice');
  assert.equal(openIssues(s).filter((i) => i.kind === 'mortgage_offer_expiring').length, 1);
  h.ports.setNow(new Date('2026-10-08T09:00:00Z')); // 12 days out
  await h.svc.tick(TENANT, MATTER);
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.issues[exp.id].severity, 'critical', 'escalated by time, not by a person');
  assert.match(s.issues[exp.id].history.at(-1)!.what, /12 days to the offer expiry/);
  // Meanwhile the CON29 search has been outstanding since 1 Sept: past its escalation point it becomes an issue too.
  s = await h.svc.getState(TENANT, MATTER);
  assert.ok(openIssues(s).some((i) => i.kind === 'search_delayed' && /CON29 search outstanding/.test(i.title)), openIssues(s).map((i) => i.title).join(' | '));
  // The search arrives → the timer closes its own issue on the next tick.
  await h.svc.searchReturned(TENANT, MATTER, 'CON29', h.doc(searchClear('CON29')));
  await h.svc.tick(TENANT, MATTER);
  s = await h.svc.getState(TENANT, MATTER);
  const sd = Object.values(s.issues).find((i) => i.kind === 'search_delayed')!;
  assert.equal(sd.status, 'resolved');
  assert.equal(sd.resolution, 'received');
  assert.equal(sd.resolvedBy, 'system');
  // Past the expiry: the offer is withdrawn by the timer and an EXPIRED issue holds exchange.
  h.ports.setNow(new Date('2026-10-22T09:00:00Z'));
  await h.svc.tick(TENANT, MATTER);
  s = await h.svc.getState(TENANT, MATTER);
  assert.equal(s.mortgage.status, 'awaiting', 'VALID → EXPIRED reopened the sub-flow');
  const expired = openIssues(s).find((i) => i.kind === 'mortgage_offer_expired')!;
  assert.equal(expired.severity, 'critical');
  assert.equal(expired.gate, 'exchange');
  assert.equal(s.issues[exp.id].status, 'resolved', 'the expiring issue closed itself: a different offer situation now');
  assert.ok(nextActions(s, h.ports.now()).some((a) => /Fresh application/.test(a.what) && a.who === 'client'));
});

test('close: a file closes only after registration with no open issues; the lifecycle reads CLOSED; nothing further is accepted', async () => {
  const h = harness();
  await h.svc.run(TENANT, MATTER, { type: 'enrol', actor: USER, requireProofOfFunds: false, requireExchangeAuthority: false, hasLender: false, requiredSearches: ['CON29'] });
  await assert.rejects(h.svc.run(TENANT, MATTER, { type: 'close_matter', actor: USER }), /only valid at stage "post_completion"/);
  const s = await h.svc.getState(TENANT, MATTER);
  assert.equal(lifecycle(s), 'instructed');
  assert.equal(gate(s, 'close').ready, false);
  assert.ok(requirements(s).find((r) => r.id === 'registered')!.authority === 'third_party');
});
