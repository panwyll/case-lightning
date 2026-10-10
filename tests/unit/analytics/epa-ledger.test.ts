/** The attention timeline (docs/epa.md §2): each minute of a person's day to at most one item, worked cases checked by hand. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attribute, completionSpans, DEFAULT_LUNCH, measure, type Completion, type Span } from '../../../lib/server/epa/ledger';
import { fromBaselineCategory, fromChip, fromTask } from '../../../lib/server/epa/taxonomy';

const T0 = Date.parse('2026-10-06T08:00:00Z'); // 09:00 BST, a Tuesday
const at = (min: number) => T0 + min * 60_000;
const span = (item: string, from: number, to: number, kind: Span['kind'] = 'chasing', source: Span['source'] = 'focus'): Span => ({ start: at(from), end: at(to), item, kind, source });
const DAY = { workdayStart: '09:00', workdayEnd: '17:30' };
const total = (sl: ReturnType<typeof attribute>) => sl.reduce((a, s) => a + (s.end - s.start) / 60_000, 0);

test('the in-tray of three done one after another is 60 minutes of work, not 120', () => {
  // Three items arrive at 09:00. Sitting in the tray is not work; each is opened in turn.
  const sl = attribute([span('a', 0, 20), span('b', 20, 40), span('c', 40, 60)]);
  assert.equal(total(sl), 60);
  assert.deepEqual(sl.map((s) => [s.span.item, (s.end - s.start) / 60_000]), [['a', 20], ['b', 20], ['c', 20]]);
});

test('a switch and back: the item switched to wins while it is open, and no minute counts twice', () => {
  // A open 0–30 (its panel left open), B opened at 10 and closed at 20.
  const sl = attribute([span('a', 0, 30), span('b', 10, 20)]);
  assert.deepEqual(sl.map((s) => [s.span.item, (s.start - T0) / 60_000, (s.end - T0) / 60_000]), [['a', 0, 10], ['b', 10, 20], ['a', 20, 30]]);
  assert.equal(total(sl), 30);
});

test('stronger evidence wins: a draft open in Outlook behind a review in CONVEYi gives the review the overlap', () => {
  const sl = attribute([span('draft', 0, 30, 'chasing', 'compose'), span('review', 10, 25, 'legal_review', 'focus')]);
  assert.deepEqual(sl.map((s) => [s.span.item, (s.end - s.start) / 60_000]), [['draft', 10], ['review', 15], ['draft', 5]]);
  // An estimate never displaces anything measured; it only fills time nothing else covers.
  const est = attribute([span('sent-1', 20, 30, 'status_updates', 'estimate'), span('review', 22, 28, 'legal_review')]);
  assert.deepEqual(est.map((s) => [s.span.item, (s.end - s.start) / 60_000]), [['sent-1', 2], ['review', 6], ['sent-1', 2]]);
  assert.equal(total(est), 10);
});

test('the result never depends on the order the evidence arrived in', () => {
  const spans = [span('a', 0, 30, 'chasing', 'reading'), span('b', 0, 30, 'admin', 'reading'), span('c', 5, 10)];
  const one = attribute(spans).map((s) => [s.span.item, s.start, s.end]);
  assert.deepEqual(attribute([...spans].reverse()).map((s) => [s.span.item, s.start, s.end]), one);
});

test('the week: efficiency, RAG, measured share, switches, focus blocks and after hours, worked by hand', () => {
  const sl = attribute([
    span('title', 0, 40, 'legal_review'),             // 40 green, one long block
    span('chase-1', 40, 45, 'chasing'),               // 5 red
    span('chase-2', 45, 50, 'chasing'),               // 5 red
    span('upd', 50, 60, 'status_updates', 'estimate'), // 10 red, estimated
    span('draft', 60, 80, 'checking_drafts'),         // 20 amber
    span('late', 600, 620, 'legal_review'),           // 19:00 BST: 20 green after hours, a new stretch
  ]);
  sl.find((s) => s.span.item === 'draft')!.span.action = 'chase';
  const m = measure(sl, DAY);
  assert.deepEqual(m.rag, { red: 20, amber: 20, green: 60 });
  assert.equal(m.efficiency, 0.6);
  assert.equal(m.measuredShare, 90 / 100);
  assert.deepEqual(m.checkingByAction, { chase: 20 });
  assert.equal(m.afterHoursShare, 0.2);
  assert.equal(m.minutes.chasing, 10);
  // 4 switches in the first stretch (title→chase-1→chase-2→upd→draft); the evening is a new stretch, not a switch.
  assert.equal(m.switchesPerHour, 4 / (100 / 60));
  assert.equal(m.unattributedMinutes, 0);
  assert.equal(m.medianBlockMinutes, 15); // blocks 5, 5, 10, 20, 20, 40
  assert.equal(m.longBlockShare, 40 / 100);
});

test('a gap inside a working stretch is unattributed, shown and never guessed', () => {
  const m = measure(attribute([span('a', 0, 10), span('b', 18, 30)]), DAY);
  assert.equal(m.unattributedMinutes, 8);
  assert.equal(m.rag.red, 22);
});

test('kinds: a chaser is a chaser; a proposal is checking a draft of something; reviews are legal', () => {
  assert.deepEqual(fromTask({ kind: 'proposal:chase', chip: "Seller's Solicitor Chaser" }), { kind: 'checking_drafts', of: 'chasing', action: 'chase' });
  assert.deepEqual(fromTask({ kind: 'proposal:chase', chip: 'Lender Request' }), { kind: 'checking_drafts', of: 'requesting', action: 'chase' });
  assert.equal(fromTask({ kind: 'proposal:client_update', chip: 'Client Update' }).of, 'status_updates');
  assert.equal(fromTask({ kind: 'proposal:acknowledgement', chip: 'Client Acknowledgement' }).of, 'acknowledging');
  assert.equal(fromTask({ kind: 'proposal:enquiry_draft', chip: 'Other Side Enquiries' }).kind, 'negotiating', 'enquiries are the conveyancer\'s own work');
  assert.equal(fromTask({ kind: 'search', chip: 'Document Sign-Off' }).kind, 'legal_review');
  assert.equal(fromTask({ kind: 'bank_details', chip: 'Verify Details' }).kind, 'payments');
  assert.equal(fromTask({ kind: 'step', chip: 'Record Receipt' }).kind, 'admin');
  assert.equal(fromTask({ kind: 'step', chip: 'Send Client Documents' }).kind, 'sending_documents');
  assert.equal(fromTask({ kind: 'step', chip: 'Exchange Contracts' }).kind, 'exchange_completion');
  assert.equal(fromChip('Chase The Client').kind, 'chasing');
  assert.equal(fromBaselineCategory('chaser_received'), 'being_chased');
  assert.equal(fromBaselineCategory('legal_work'), 'legal_review');
});

import { baselineEfficiency, buildEpaReport, emailEvidence, weekStart } from '../../../lib/server/epa/report';
import { DEFAULT_LEVELS } from '../../../lib/server/engine/types';

test('a sent email is a completion; when Outlook timed its draft, the writing is evidence too', () => {
  const timed = emailEvidence({ id: 'm1', category: 'chaser', draftedAt: '2026-10-06T09:00:00Z', sentAt: '2026-10-06T09:04:00Z' })!;
  assert.equal(timed.compose!.source, 'compose');
  assert.equal((timed.compose!.end - timed.compose!.start) / 60_000, 4);
  assert.deepEqual(timed.done, { at: Date.parse('2026-10-06T09:04:00Z'), item: 'email:m1', kind: 'chasing' });
  assert.equal(emailEvidence({ id: 'm2', category: 'status_update', draftedAt: null, sentAt: '2026-10-06T10:00:00Z' })!.compose, null);
  assert.equal(emailEvidence({ id: 'm3', category: 'internal', draftedAt: null, sentAt: '2026-10-06T10:00:00Z' }), null, 'colleagues are not counted');
});

test('the report: weeks cut at Monday so nothing counts twice, the Pareto biggest first with the action that takes each', () => {
  const mon = weekStart(Date.parse('2026-10-07T12:00:00Z'));
  assert.equal(new Date(mon).toISOString(), '2026-10-05T00:00:00.000Z');
  const m = (min: number) => mon + 9 * 3_600_000 + min * 60_000;
  const spans: Span[] = [
    { start: mon - 30 * 60_000, end: mon + 30 * 60_000, item: 'late', kind: 'admin', source: 'focus' }, // Sunday night into Monday
    { start: m(0), end: m(60), item: 'title', kind: 'legal_review', source: 'focus' },
    { start: m(60), end: m(90), item: 'c', kind: 'chasing', source: 'focus' },
    { start: m(90), end: m(100), item: 'a', kind: 'acknowledging', source: 'focus' },
    { start: m(100), end: m(140), item: 'd', kind: 'checking_drafts', of: 'chasing', action: 'chase', source: 'focus' },
  ];
  const r = buildEpaReport({ spans, now: m(200), weeks: 2, workday: { workdayStart: '09:00', workdayEnd: '17:30' }, levels: { ...DEFAULT_LEVELS, acknowledgement: 'assist' }, tasks: [{ kind: 'chasing', openedAt: m(-600), closedAt: m(60) }], baselineEfficiency: 0.3 });
  assert.equal(r.weeks.length, 2);
  assert.equal(r.weeks[0].measures.minutes.admin, 30, 'Sunday\'s half stays in last week');
  assert.equal(r.weeks[1].measures.minutes.admin, 30);
  assert.deepEqual(r.pareto.map((b) => [b.kind, b.hours]), [['checking_drafts', 0.67], ['chasing', 0.5], ['admin', 0.5], ['acknowledging', 0.17]]);
  assert.equal(r.pareto[r.pareto.length - 1].cumulative, 1);
  assert.deepEqual(r.pareto.find((b) => b.kind === 'chasing')!.action, { key: 'chase', label: 'Chases', level: 'propose', sendsUnasked: false });
  assert.equal(r.pareto.find((b) => b.kind === 'acknowledging')!.action!.sendsUnasked, true);
  assert.equal(r.pareto.find((b) => b.kind === 'admin')!.action, null, 'no action is suggested where CONVEYi has none');
  assert.deepEqual(r.pareto[0].parts, [{ action: 'chase', label: 'Chases', hours: 0.67, level: 'propose' }]);
  assert.deepEqual(r.queue, [{ kind: 'chasing', label: 'Chasing', done: 1, medianHours: 11, p85Hours: 11 }]);
});

test('baseline efficiency from the mailbox scan\'s hours', () => {
  assert.equal(baselineEfficiency([{ category: 'chaser', hoursPerWeek: 3 }, { category: 'legal_work', hoursPerWeek: 1 }, { category: 'internal', hoursPerWeek: 5 }]), 0.25);
});

const RULES = { ...DAY, ...DEFAULT_LUNCH };
const done = (item: string, min: number, kind: Completion['kind'] = 'chasing'): Completion => ({ at: at(min), item, kind });
const mins = (sp: Span[]) => sp.map((s) => [s.item, (s.end - s.start) / 60_000]);

test('completions: the in-tray of three, each given the time since the one before, from the start of the day', () => {
  // Finished at 09:20, 09:40, 10:00.
  assert.deepEqual(mins(completionSpans([done('a', 20), done('b', 40), done('c', 60)], RULES)), [['a', 20], ['b', 20], ['c', 20]]);
});

test('completions: routine work is capped at an hour, legal work at three; lunch is never work', () => {
  // A chaser at 11:30 after nothing since 09:00: an hour, not two and a half.
  assert.deepEqual(mins(completionSpans([done('c', 150)], RULES)), [['c', 60]]);
  // A title review at 12:00 after 09:00: three hours.
  assert.deepEqual(mins(completionSpans([done('t', 180, 'legal_review')], RULES)), [['t', 180]]);
  // A review done 12:30 then one finished 14:30 (BST): 13:00–14:00 is lunch, so the second is 30 + 30 minutes.
  const sp = completionSpans([done('a', 210, 'legal_review'), done('b', 330, 'legal_review')], RULES);
  assert.deepEqual(mins(sp).filter(([i]) => i === 'b'), [['b', 30], ['b', 30]]);
});

test('completions: a run of approvals in one sitting shares the time before it', () => {
  // Nothing since 10:00; five chasers approved 10:30:00–10:30:40.
  const ev = [done('x', 60), ...[0, 10, 20, 30, 40].map((sec, n) => ({ at: at(90) + sec * 1000, item: `c${n}`, kind: 'chasing' as const }))];
  const sp = completionSpans(ev, RULES).filter((s) => s.item.startsWith('c'));
  assert.equal(sp.length, 5);
  for (const s of sp) assert.ok(Math.abs((s.end - s.start) / 60_000 - 30.6667 / 5) < 0.01);
});

test('completions out of hours are kept (they count as after hours) and capped', () => {
  // An email at 21:00 after the last thing at 17:00: an hour, not four.
  assert.deepEqual(mins(completionSpans([done('a', 480, 'admin'), done('late', 720, 'status_updates')], RULES)).filter(([i]) => i === 'late'), [['late', 60]]);
});
