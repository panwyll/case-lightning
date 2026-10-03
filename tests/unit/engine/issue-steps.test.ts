/**
 * An issue's next steps do different things (issues.ts IssueStep): record what settles it, refer it,
 * set a deadline, send an ID check, change the clients, close the case, as well as write to someone.
 * Every step on every kind must be one the engine accepts: an outcome the kind can be resolved with,
 * an action whose command is a real user command that succeeds on a case with that issue open.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, type Command } from '../../../lib/server/engine/machine';
import { applyEvent } from '../../../lib/server/engine/projection';
import { matterWork } from '../../../lib/server/engine/work';
import { userCommandSchema } from '../../../lib/server/engine/http';
import { ISSUE_KINDS, ISSUE_KIND_SPEC, issueSteps } from '../../../lib/server/engine/issues';
import { initialState, type EngineEvent, type MatterState } from '../../../lib/server/engine/types';
import { TENANT, MATTER, USER } from './helpers';

const NOW = new Date('2026-10-03T10:00:00Z');
let seq = 0;
const fold = (s: MatterState, cmd: Record<string, unknown>): MatterState => {
  const { events } = decide(s, { actor: USER, ...cmd } as unknown as Command, { now: NOW });
  return events.map((e) => ({ ...e, id: `e${++seq}`, seq, tenantId: TENANT, matterId: MATTER, createdAt: NOW.toISOString(), sourceDocumentId: e.sourceDocumentId ?? null } as unknown as EngineEvent)).reduce(applyEvent, s);
};
const base = initialState(TENANT, MATTER);
const CASE: MatterState = { ...base, enrolled: true, partyNames: ['Asha Patel', 'Ben Carter'], parties: 2, purchasePricePennies: 30_000_000, transactionType: 'freehold_purchase', stage: 'pre_exchange', hasLender: true };
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
      let s = fold(CASE, { type: 'raise_issue', kind, title: `Test ${kind}`, detail: 'Raised in a test', gate: 'exchange', party: 'Asha Patel' });
      const id = Object.keys(s.issues).find((k) => s.issues[k].kind === kind)!;
      const fill = (v: unknown): unknown => (v === '$issue' ? id : v === '$party' ? 'Asha Patel' : v === '$partyCheck' ? null : v === '$status' ? 'open' : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, w]) => [k, fill(w)])) : v);
      const body: Record<string, unknown> = { type: x.command, ...(fill(x.args ?? {}) as Record<string, unknown>) };
      for (const f of x.fields ?? []) body[f.key] = f.type === 'money' ? 150_000 : f.type === 'names' ? ['Asha Patel'] : SAMPLE[f.type];
      const parsed = userCommandSchema.safeParse(body);
      if (!parsed.success) { bad.push(`${kind}: ${x.label}: refused by the schema: ${parsed.error.issues[0]?.message}`); continue; }
      try { s = fold(s, parsed.data as Record<string, unknown>); } catch (e) { bad.push(`${kind}: ${x.label}: ${(e as Error).message}`); continue; }
      if (x.command === 'abandon_matter') { if (!s.abandoned) bad.push(`${kind}: ${x.label}: the case did not close`); continue; }
      // An enquiry raised from the issue tracks it: the issue waits on the reply.
      const waiting = s.issues[id].enquiryIds.length > 0 && matterWork(s, NOW).items.some((t) => t.id.startsWith('waiting:') || t.id.includes('enquir'));
      if (!waiting && !matterWork(s, NOW).items.some((t) => t.id === `do:issue:${id}`)) bad.push(`${kind}: ${x.label}: the issue left the Tasks list`);
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

test('the kinds people meet most offer more than writing to someone', () => {
  for (const kind of ['probate_issue', 'power_of_attorney_issue', 'bankruptcy_insolvency', 'complaint', 'aml_kyc_problem', 'joint_client_conflict', 'client_change', 'third_party_consent', 'retention_held', 'title_defect', 'survey_defect'] as const) {
    const kinds = new Set(issueSteps(kind).map((x) => x.kind));
    assert.ok(kinds.has('outcome') || kinds.has('action'), `${kind} only writes to people`);
  }
});
