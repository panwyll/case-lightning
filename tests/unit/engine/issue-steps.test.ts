/**
 * An issue is never a dead end (docs/spec/issues.md "Next steps"): each kind offers what a person
 * does about it — write to someone (drafted from the case, edited, sent, logged on the issue),
 * agree new dates, mark it negotiating, or say it has fallen through — beside its outcomes. What a person
 * does depends on the issue: a step can also record what settles it (the grant, the consent) or do
 * something on the case (refer it, set a deadline, send an ID check, change the clients, close the case).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ISSUE_KINDS, ISSUE_KIND_SPEC, issueSteps } from '../../../lib/server/engine/issues';
import { MockClientComms } from '../../../lib/server/engine/mocks';
import { harness, TENANT, MATTER, USER } from './helpers';
import { decide, type Command } from '../../../lib/server/engine/machine';
import { applyEvent } from '../../../lib/server/engine/projection';
import { matterWork } from '../../../lib/server/engine/work';
import { userCommandSchema } from '../../../lib/server/engine/http';
import { initialState, type EngineEvent, type MatterState } from '../../../lib/server/engine/types';


test('every kind a person resolves offers a next step; transaction at risk offers the full set and a way out', () => {
  for (const k of ISSUE_KINDS) {
    if (['file_locked', 'unknown_correspondent', 'send_failed', 'document_revised'].includes(k) || ISSUE_KIND_SPEC[k].context) continue;
    assert.ok(issueSteps(k).length > 0, `${k} has next steps`);
  }
  const risk = issueSteps('transaction_at_risk').map((x) => x.kind === 'message' ? `${x.kind}:${x.to}` : x.kind);
  assert.deepEqual(risk, ['message:seller_solicitor', 'message:client', 'message:estate_agent', 'outcome', 'dates', 'negotiating', 'fatal']);
  assert.ok(ISSUE_KIND_SPEC.transaction_at_risk.resolutions.includes('proceeding_confirmed'));
});

test('acting for the seller, a property problem is put to our client, not the other side', () => {
  const buyer = issueSteps('building_regs_missing', 'buyer').filter((x) => x.kind === 'message').map((x) => x.kind === 'message' && x.to);
  const seller = issueSteps('building_regs_missing', 'seller').filter((x) => x.kind === 'message').map((x) => x.kind === 'message' && x.to);
  // Acting for the buyer it is an enquiry of the other side (and the client is told); acting for the seller, our client is asked.
  assert.deepEqual(buyer, ['client']);
  assert.equal(issueSteps('building_regs_missing', 'buyer')[0].id, 'enquiry');
  assert.deepEqual(seller, ['client', 'seller_solicitor']);
  assert.equal(issueSteps('building_regs_missing', 'seller')[0].label, 'Ask The Client');
  assert.ok(!issueSteps('building_regs_missing', 'seller').some((x) => x.id === 'enquiry'), 'the seller does not raise enquiries');
  assert.ok(issueSteps('building_regs_missing', 'seller').some((x) => x.kind === 'outcome' && x.resolution === 'indemnity_policy'));
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

const NOW = new Date('2026-10-03T10:00:00Z');
let seq = 0;
const fold = (s: MatterState, cmd: Record<string, unknown>): MatterState => {
  const { events } = decide(s, { actor: USER, ...cmd } as unknown as Command, { now: NOW });
  return events.map((e) => ({ ...e, id: `e${++seq}`, seq, tenantId: TENANT, matterId: MATTER, createdAt: NOW.toISOString(), sourceDocumentId: e.sourceDocumentId ?? null } as unknown as EngineEvent)).reduce(applyEvent, s);
};
const base = initialState(TENANT, MATTER);
const CASE: MatterState = { ...base, enrolled: true, partyNames: ['Asha Patel', 'Ben Carter'], parties: 2, purchasePricePennies: 30_000_000, transactionType: 'freehold_purchase', stage: 'pre_exchange', hasLender: true };
/** The cases an action is tried on, in order: the first that accepts it counts (a fresh redemption statement needs a mortgage to redeem). */
const CASES: MatterState[] = [CASE, { ...CASE, transactionType: 'freehold_sale', hasLender: false, hasExistingMortgage: true }, { ...CASE, transactionType: 'remortgage', stage: 'pre_completion', hasExistingMortgage: true }];
const COMMANDS = new Set((userCommandSchema as unknown as { options: Array<{ shape: { type: { value: string } } }> }).options.map((o) => o.shape.type.value));
const SAMPLE: Record<string, string> = { text: 'A test', note: 'Checked in a test', date: '2026-11-30', money: '1500', names: 'Asha Patel' };

test('every outcome step is one its kind can be resolved with, and every action command is a real command', () => {
  const bad: string[] = [];
  for (const kind of ISSUE_KINDS) for (const side of ['buyer', 'seller'] as const) for (const x of issueSteps(kind, side)) {
    if (x.kind === 'outcome' && !ISSUE_KIND_SPEC[kind].resolutions.includes(x.resolution)) bad.push(`${kind}: ${x.label} → ${x.resolution} is not one of its outcomes`);
    if (x.kind === 'action' && !COMMANDS.has(x.command)) bad.push(`${kind}: ${x.label} → ${x.command} is not a command`);
  }
  assert.deepEqual(bad, []);
});

test('every action step succeeds on a case with that issue open, and the issue stays on the Tasks list (or the case closes)', () => {
  const bad: string[] = [];
  for (const kind of ISSUE_KINDS) {
    if (ISSUE_KIND_SPEC[kind].context) continue;
    for (const x of issueSteps(kind, 'buyer')) {
      if (x.kind !== 'action') continue;
      const tried: string[] = [];
      let ok = false;
      for (const c of CASES) {
        let s = fold(c, { type: 'raise_issue', kind, title: `Test ${kind}`, detail: 'Raised in a test', gate: 'exchange', party: 'Asha Patel' });
        const id = Object.keys(s.issues).find((k) => s.issues[k].kind === kind)!;
        const fill = (v: unknown): unknown => (v === '$issue' ? id : v === '$party' ? 'Asha Patel' : v === '$partyCheck' ? null : v === '$status' ? 'open' : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, w]) => [k, fill(w)])) : v);
        const body: Record<string, unknown> = { type: x.command, ...(fill(x.args ?? {}) as Record<string, unknown>) };
        for (const f of x.fields ?? []) body[f.key] = f.type === 'money' ? 150_000 : f.type === 'names' ? ['Asha Patel'] : SAMPLE[f.type];
        const parsed = userCommandSchema.safeParse(body);
        if (!parsed.success) { tried.push(`refused by the schema: ${parsed.error.issues[0]?.message}`); break; }
        try { s = fold(s, parsed.data as Record<string, unknown>); } catch (e) { tried.push((e as Error).message); continue; }
        if (x.command === 'abandon_matter') { if (!s.abandoned) tried.push('the case did not close'); else ok = true; break; }
        // An enquiry raised from the issue tracks it: the issue waits on the reply.
        const waiting = s.issues[id].enquiryIds.length > 0;
        if (!waiting && !matterWork(s, NOW).items.some((t) => t.id === `do:issue:${id}`)) { tried.push('the issue left the Tasks list'); break; }
        ok = true; break;
      }
      if (!ok) bad.push(`${kind}: ${x.label}: ${tried.join(' | ')}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('a referred issue is chipped as theirs on the Tasks list', () => {
  let s = fold(CASE, { type: 'raise_issue', kind: 'aml_kyc_problem', title: 'PEP match on the buyer', detail: null, gate: 'exchange' });
  const id = Object.keys(s.issues)[0];
  s = fold(s, { type: 'update_issue', issueId: id, status: 'open', referredTo: 'mlro', note: 'Decide on enhanced due diligence' });
  assert.equal(s.issues[id].referredTo, 'mlro');
  assert.equal(matterWork(s, NOW).items.find((t) => t.id === `do:issue:${id}`)?.chip, 'With The MLRO');
  assert.throws(() => fold(s, { type: 'update_issue', issueId: id, status: 'open', referredTo: 'partner' }), /decide/);
});

test('no issue kind only writes to people: each offers something that settles it or a thing to do', () => {
  const bad: string[] = [];
  for (const kind of ISSUE_KINDS) for (const side of ['buyer', 'seller'] as const) {
    if (ISSUE_KIND_SPEC[kind].context) continue;
    const st = issueSteps(kind, side);
    if (!st.length) continue; // closed by their own act (Try Again, the password)
    if (!st.some((x) => x.kind === 'outcome' || x.kind === 'action')) bad.push(`${kind} (${side})`);
    const ids = st.map((x) => x.id);
    if (new Set(ids).size !== ids.length) bad.push(`${kind} (${side}): two steps share an id`);
  }
  assert.deepEqual(bad, []);
});
