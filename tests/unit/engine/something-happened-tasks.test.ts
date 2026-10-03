/**
 * Every option in Something Happened, recorded on a case where it is allowed, puts something new on the Tasks list
 * (the same items the list shows: matterWork). The options are read from the command schema, so a new one is
 * covered the day it is added.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, type Command } from '../../../lib/server/engine/machine';
import { applyEvent } from '../../../lib/server/engine/projection';
import { matterWork } from '../../../lib/server/engine/work';
import { userCommandSchema } from '../../../lib/server/engine/http';
import { CASE_SHAPES, SHAPE_SPEC } from '../../../lib/server/engine/shapes';
import { ISSUE_KINDS, ISSUE_KIND_SPEC } from '../../../lib/server/engine/issues';
import { initialState, type EngineEvent, type MatterState } from '../../../lib/server/engine/types';
import { TENANT, MATTER, USER } from './helpers';

const NOW = new Date('2026-10-03T10:00:00Z');
let seq = 0;
const fold = (s: MatterState, cmd: Record<string, unknown>): MatterState => {
  const { events } = decide(s, { actor: USER, ...cmd } as unknown as Command, { now: NOW });
  return events.map((e) => ({ ...e, id: `e${++seq}`, seq, tenantId: TENANT, matterId: MATTER, createdAt: NOW.toISOString(), sourceDocumentId: e.sourceDocumentId ?? null } as unknown as EngineEvent)).reduce(applyEvent, s);
};
const base = initialState(TENANT, MATTER);
const ex = { ...base.exchange, exchangedAt: '2026-09-25T10:00:00Z', completionDate: '2026-10-16' };
const done = { ...base.completion, confirmedAt: '2026-10-01T10:00:00Z' };
const common = { enrolled: true, partyNames: ['Asha Patel', 'Ben Carter'], parties: 2, purchasePricePennies: 30_000_000 };
/** The cases an option might be recorded on, in order: the first that accepts it is used. */
const SOLE: MatterState = { ...base, enrolled: true, partyNames: ['Asha Patel'], parties: 1, purchasePricePennies: 30_000_000, transactionType: 'freehold_purchase', stage: 'pre_exchange', hasLender: true };
const CASES: Array<[string, MatterState]> = [
  ['purchase before exchange', { ...base, ...common, transactionType: 'freehold_purchase', stage: 'pre_exchange', hasLender: true, shapes: ['lifetime_isa', 'help_to_buy_isa'] }],
  ['sale before exchange', { ...base, ...common, transactionType: 'freehold_sale', stage: 'pre_exchange', hasLender: false, hasExistingMortgage: true }],
  ['remortgage', { ...base, ...common, transactionType: 'remortgage', stage: 'pre_completion', hasLender: true, hasExistingMortgage: true }],
  ['purchase exchanged', { ...base, ...common, transactionType: 'freehold_purchase', stage: 'pre_completion', hasLender: true, exchange: ex }],
  ['purchase completed', { ...base, ...common, transactionType: 'freehold_purchase', stage: 'post_completion', hasLender: true, exchange: ex, completion: done, postCompletion: { ...base.postCompletion, sdltSubmittedAt: '2026-10-05T10:00:00Z' }, sdltFiledPennies: 500_000 }],
  ['sale completed', { ...base, ...common, transactionType: 'freehold_sale', stage: 'post_completion', hasLender: false, hasExistingMortgage: true, exchange: ex, completion: done }],
];
const shown = (s: MatterState) => new Set(matterWork(s, NOW).items.map((i) => i.id));

function check(label: string, body: Record<string, unknown>, cases: Array<[string, MatterState]> = CASES): string | null {
  const tried: string[] = [];
  for (const [name, s] of cases) {
    let after: MatterState;
    try { after = fold(s, body); } catch (e) { tried.push(`${name}: ${(e as Error).message.slice(0, 60)}`); continue; }
    const before = shown(s);
    const now = shown(after);
    // A wait the event itself opened counts (the NCA's answer); waits a bare test case opens on its own do not.
    const added = [...now].filter((id) => !before.has(id) && !id.startsWith('waiting:'));
    // Every issue the event raised is a task, not only one of them.
    const raised = Object.keys(after.issues).filter((id) => !s.issues[id] && after.issues[id].status === 'open');
    const hidden = raised.filter((id) => !now.has(`do:issue:${id}`));
    if (hidden.length) return `${label} on "${name}": not on the Tasks list: ${hidden.map((id) => after.issues[id].title).join('; ')}`;
    return added.length ? null : `${label}: recorded on "${name}" but nothing new on the Tasks list`;
  }
  return `${label}: not accepted on any test case (${tried.join(' | ')})`;
}

const enumOf = (type: string, field = 'event'): string[] => {
  const o = (userCommandSchema as unknown as { options: Array<{ shape: Record<string, { options?: string[]; _def?: { innerType?: { options?: string[] } } }> }> }).options.find((x) => (x.shape.type as unknown as { value: string }).value === type)!;
  const f = o.shape[field];
  return f.options ?? f._def?.innerType?.options ?? [];
};

test('every Something Happened option puts something on the Tasks list', () => {
  const failures: string[] = [];
  const detail = 'Recorded in a test';
  for (const event of enumOf('record_party_event')) failures.push(check(`person: ${event}`, { type: 'record_party_event', event, party: 'Asha Patel', note: detail }) ?? '');
  // The sole client on a purchase (where a death once raised two issues nobody could see).
  const soleFailures = enumOf('record_party_event').map((event) => check(`person (sole client): ${event}`, { type: 'record_party_event', event, party: 'Asha Patel', note: detail }, [['sole-client purchase', SOLE], ...CASES]) ?? '').filter(Boolean);
  for (const event of enumOf('record_property_event')) failures.push(check(`property: ${event}`, { type: 'record_property_event', event, detail }) ?? '');
  for (const event of enumOf('record_deal_event')) failures.push(check(`deal: ${event}`, { type: 'record_deal_event', event, detail, until: '2026-11-30', amountPennies: 200_000 }) ?? '');
  for (const event of enumOf('record_completion_event')) failures.push(check(`completion: ${event}`, { type: 'record_completion_event', event, detail, amountPennies: 200_000, until: '2027-01-30' }) ?? '');
  for (const shape of CASE_SHAPES) failures.push(check(`shape: ${SHAPE_SPEC[shape].label}`, { type: 'add_shape', shape }) ?? '');
  failures.push(check('ISA: Lifetime ISA opened', { type: 'record_isa', isa: 'lifetime_isa', openedOn: '2026-08-01' }) ?? '');
  failures.push(check('ISA: Help to Buy ISA closed', { type: 'record_isa', isa: 'help_to_buy_isa', closedOn: '2026-08-01' }) ?? '');
  failures.push(check('SDLT amended', { type: 'sdlt_amended', newAmountPennies: 400_000, reason: detail }) ?? '');
  failures.push(check('report to the NCA', { type: 'sar_made', note: detail }) ?? '');
  // Every option was actually tried (the enums were read): parties, property, deal, completion, shapes, and the four others.
  assert.ok(enumOf('record_party_event').length >= 22 && enumOf('record_property_event').length >= 9 && enumOf('record_deal_event').length >= 9 && enumOf('record_completion_event').length >= 7, `enums: ${['record_party_event', 'record_property_event', 'record_deal_event', 'record_completion_event'].map((x) => enumOf(x).length).join(', ')}`);
  assert.equal(failures.length, enumOf('record_party_event').length + enumOf('record_property_event').length + enumOf('record_deal_event').length + enumOf('record_completion_event').length + CASE_SHAPES.length + 4);
  const bad = [...failures.filter(Boolean), ...soleFailures];
  assert.deepEqual(bad, [], `\n${bad.join('\n')}`);
});

test('every issue kind raised by hand is a task (except the ones kept as context on the file)', () => {
  const bad: string[] = [];
  for (const kind of ISSUE_KINDS) {
    if (ISSUE_KIND_SPEC[kind]?.context) continue;
    const r = check(`raise: ${kind}`, { type: 'raise_issue', kind, title: `Test ${kind}`, detail: 'Raised in a test', gate: 'none' });
    if (r) bad.push(r);
  }
  assert.deepEqual(bad, []);
});
