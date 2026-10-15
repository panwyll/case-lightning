/** The attention timeline (docs/epa.md §2): each minute of a person's day to at most one item, worked cases checked by hand. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attribute, completionSpans, DEFAULT_LUNCH, measure, type Completion, type Span } from '../../../lib/server/epa/ledger';
import { EPA_KINDS, EPA_SPEC, fromChip, fromEmail, fromTask } from '../../../lib/server/epa/taxonomy';

const T0 = Date.parse('2026-10-06T08:00:00Z'); // 09:00 BST, a Tuesday
const at = (min: number) => T0 + min * 60_000;
const span = (item: string, from: number, to: number, kind: Span['kind'] = 'client_chasers', source: Span['source'] = 'focus'): Span => ({ start: at(from), end: at(to), item, kind, source });
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
  const sl = attribute([span('draft', 0, 30, 'client_chasers', 'compose'), span('review', 10, 25, 'title_review', 'focus')]);
  assert.deepEqual(sl.map((s) => [s.span.item, (s.end - s.start) / 60_000]), [['draft', 10], ['review', 15], ['draft', 5]]);
  // An estimate never displaces anything measured; it only fills time nothing else covers.
  const est = attribute([span('sent-1', 20, 30, 'client_updates', 'estimate'), span('review', 22, 28, 'title_review')]);
  assert.deepEqual(est.map((s) => [s.span.item, (s.end - s.start) / 60_000]), [['sent-1', 2], ['review', 6], ['sent-1', 2]]);
  assert.equal(total(est), 10);
});

test('the result never depends on the order the evidence arrived in', () => {
  const spans = [span('a', 0, 30, 'client_chasers', 'reading'), span('b', 0, 30, 'filing', 'reading'), span('c', 5, 10)];
  const one = attribute(spans).map((s) => [s.span.item, s.start, s.end]);
  assert.deepEqual(attribute([...spans].reverse()).map((s) => [s.span.item, s.start, s.end]), one);
});

test('the week: efficiency, RAG, measured share, switches, focus blocks and after hours, worked by hand', () => {
  const sl = attribute([
    span('title', 0, 40, 'title_review'),             // 40 green, one long block
    span('chase-1', 40, 45, 'client_chasers'),               // 5 red
    span('chase-2', 45, 50, 'client_chasers'),               // 5 red
    span('upd', 50, 60, 'client_updates', 'estimate'), // 10 red, estimated
    span('draft', 60, 80, 'checking_drafts'),         // 20 amber
    span('late', 600, 620, 'title_review'),           // 19:00 BST: 20 green after hours, a new stretch
  ]);
  sl.find((s) => s.span.item === 'draft')!.span.of = 'lender_chasers';
  const m = measure(sl, DAY);
  assert.deepEqual(m.rag, { red: 40, amber: 0, green: 60 }, 'checking a draft CONVEYi could send needs no lawyer and does not move the case: red');
  assert.equal(m.efficiency, 0.6);
  assert.equal(m.measuredShare, 90 / 100);
  assert.deepEqual(m.checkingByAction, { lender_chasers: 20 });
  assert.equal(m.afterHoursShare, 0.2);
  assert.equal(m.minutes.client_chasers, 10);
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

test('kinds: named as the work by who it is with; a proposal is checking a draft of that; reviews are the legal work they are', () => {
  assert.deepEqual(fromTask({ kind: 'proposal:chase', chip: "Seller's Solicitor Chaser" }), { kind: 'checking_drafts', of: 'other_side_chasers', action: 'chase' });
  assert.deepEqual(fromTask({ kind: 'proposal:chase', chip: 'Lender Chaser' }), { kind: 'checking_drafts', of: 'lender_chasers', action: 'chase' });
  assert.equal(fromTask({ kind: 'proposal:chase', chip: 'Letter To The Agent' }).of, 'agent_updates');
  assert.equal(fromTask({ kind: 'proposal:client_update', chip: 'Client Update' }).of, 'client_updates');
  assert.equal(fromTask({ kind: 'proposal:counterparty_update', chip: 'Other Side Update' }).of, 'other_side_updates');
  assert.equal(fromTask({ kind: 'proposal:acknowledgement', chip: 'Client Acknowledgement' }).of, 'acknowledging');
  assert.equal(fromTask({ kind: 'proposal:enquiry_draft', chip: 'Other Side Enquiries' }).kind, 'raising_enquiries');
  assert.equal(fromTask({ kind: 'search', chip: 'Document Sign-Off' }).kind, 'search_review');
  assert.equal(fromTask({ kind: 'mortgage', chip: 'Document Sign-Off' }).kind, 'mortgage_offer_review');
  assert.equal(fromTask({ kind: 'bank_details', chip: 'Verify Details' }).kind, 'bank_details');
  assert.equal(fromTask({ kind: 'step', chip: 'Record Receipt' }).kind, 'recording_receipts');
  assert.equal(fromTask({ kind: 'step', chip: 'Upload Documents' }).kind, 'filing');
  assert.equal(fromTask({ kind: 'step', chip: 'File Return' }).kind, 'sdlt_return');
  assert.equal(fromTask({ kind: 'step', chip: 'Send Client Documents' }).kind, 'sending_documents_client');
  assert.equal(fromTask({ kind: 'step', chip: "Send Buyer's Solicitor Documents" }).kind, 'sending_documents_others');
  assert.equal(fromTask({ kind: 'step', chip: 'Exchange Contracts' }).kind, 'exchange');
  assert.equal(fromTask({ kind: 'issue', chip: 'Chase The Client' }).kind, 'client_chasers');
  assert.equal(fromTask({ kind: 'issue', chip: "Chase The Seller's Side" }).kind, 'other_side_chasers');
  assert.equal(fromTask({ kind: 'step', chip: 'Something New' }).kind, 'not_counted', 'an unknown chip is not guessed');
  assert.equal(fromChip('Chase The Third Party').kind, 'third_party_chasers');
  // Email, by who it went to.
  assert.equal(fromEmail('chaser', ['lender']), 'lender_chasers');
  assert.equal(fromEmail('chaser', ['other_solicitor']), 'other_side_chasers');
  assert.equal(fromEmail('update_reply', ['estate_agent']), 'agent_status_requests');
  assert.equal(fromEmail('update_reply', ['client']), 'client_any_news');
  assert.equal(fromEmail('file_send', ['client']), 'sending_documents_client');
  assert.equal(fromEmail('internal', ['colleague']), 'not_counted');
  // No label on the page is a catch-all.
  for (const k of EPA_KINDS) assert.doesNotMatch(EPA_SPEC[k].label, /^(Admin|Requests?|Sending Docs|Other)$/);
});

import { baselineSplit, buildEpaReport, emailEvidence, weekStart } from '../../../lib/server/epa/report';
import { DEFAULT_LEVELS } from '../../../lib/server/engine/types';

test('a sent email is a completion; when Outlook timed its draft, the writing is evidence too', () => {
  const timed = emailEvidence({ id: 'm1', category: 'chaser', draftedAt: '2026-10-06T09:00:00Z', sentAt: '2026-10-06T09:04:00Z' })!;
  assert.equal(timed.compose!.source, 'compose');
  assert.equal((timed.compose!.end - timed.compose!.start) / 60_000, 4);
  assert.deepEqual(timed.done, { at: Date.parse('2026-10-06T09:04:00Z'), item: 'email:m1', kind: 'client_chasers' });
  assert.equal(emailEvidence({ id: 'm2', category: 'status_update', draftedAt: null, sentAt: '2026-10-06T10:00:00Z' })!.compose, null);
  assert.equal(emailEvidence({ id: 'm3', category: 'internal', draftedAt: null, sentAt: '2026-10-06T10:00:00Z' }), null, 'colleagues are not counted');
});

test('the firm report: each person on their own timeline, added up; the latest week with time leads; times and average each', () => {
  const mon = weekStart(Date.parse('2026-10-07T12:00:00Z'));
  assert.equal(new Date(mon).toISOString(), '2026-10-05T00:00:00.000Z');
  const prev = mon - 7 * 86_400_000;
  const p = (min: number) => prev + 9 * 3_600_000 + min * 60_000;
  const asha: Span[] = [
    { start: p(0), end: p(60), item: 'title', kind: 'title_review', source: 'focus' },
    { start: p(60), end: p(90), item: 'c1', kind: 'client_chasers', source: 'focus' },
    { start: p(90), end: p(100), item: 'a', kind: 'acknowledging', source: 'focus' },
    { start: p(100), end: p(140), item: 'd', kind: 'checking_drafts', of: 'lender_chasers', action: 'chase', source: 'focus' },
  ];
  const ben: Span[] = [
    // At the same time as Asha's title review: a different person, so both count.
    { start: p(0), end: p(30), item: 'c2', kind: 'client_chasers', source: 'focus' },
    { start: mon - 30 * 60_000, end: mon + 30 * 60_000, item: 'late', kind: 'filing', source: 'focus' }, // Sunday night into Monday
  ];
  // Sunday night's admin is moved to Ben's last week so this week has nothing yet: last week leads.
  ben[1] = { start: mon - 60 * 60_000, end: mon - 30 * 60_000, item: 'late', kind: 'filing', source: 'focus' };
  const r = buildEpaReport({ people: [asha, ben], now: mon + 10 * 3_600_000, weeks: 2, workday: { workdayStart: '09:00', workdayEnd: '17:30' }, levels: { ...DEFAULT_LEVELS, acknowledgement: 'assist' }, baseline: null });
  assert.equal(r.weeks.length, 2);
  assert.equal(r.week!.start, new Date(prev).toISOString(), 'this week has nothing yet, so last week leads');
  assert.deepEqual(r.week!.hours, { red: 2.3, amber: 0, green: 1 });
  assert.deepEqual(r.week!.share, { red: 0.7, amber: 0, green: 0.3 });
  assert.equal(r.weeks[1].share, null);
  const now = buildEpaReport({ people: [asha, [{ start: mon + 9 * 3_600_000, end: mon + 9.5 * 3_600_000, item: 'x', kind: 'client_chasers', source: 'focus' }]], now: mon + 10 * 3_600_000, weeks: 2, workday: { workdayStart: '09:00', workdayEnd: '17:30' }, levels: DEFAULT_LEVELS, baseline: null });
  assert.equal(now.week!.start, new Date(mon).toISOString(), 'once this week has time, it leads');
  assert.deepEqual(r.pareto.map((b) => [b.kind, b.hours, b.times, b.avgMinutes]), [['client_chasers', 1, 2, 30], ['checking_drafts', 0.67, 1, 40], ['filing', 0.5, 1, 30], ['acknowledging', 0.17, 1, 10]]);
  assert.equal(r.pareto[r.pareto.length - 1].cumulative, 1);
  assert.deepEqual(r.pareto[0].action, { key: 'chase', label: 'Chases', level: 'propose', sendsUnasked: false });
  assert.equal(r.pareto.find((b) => b.kind === 'acknowledging')!.action!.sendsUnasked, true);
  assert.equal(r.pareto.find((b) => b.kind === 'filing')!.action, null, 'no action is suggested where CONVEYi has none');
  assert.deepEqual(r.pareto[1].parts, [{ of: 'lender_chasers', label: 'Sending Lender Chasers', hours: 0.67, action: 'chase', level: 'propose' }]);
});

test('before CONVEYi, from the mailbox scans\' hours', () => {
  assert.deepEqual(baselineSplit([{ category: 'chaser', hoursPerWeek: 3 }, { category: 'legal_work', hoursPerWeek: 1 }, { category: 'internal', hoursPerWeek: 5 }]), { red: 0.75, amber: 0, green: 0.25 });
});

const RULES = { ...DAY, ...DEFAULT_LUNCH };
const done = (item: string, min: number, kind: Completion['kind'] = 'client_chasers'): Completion => ({ at: at(min), item, kind });
const mins = (sp: Span[]) => sp.map((s) => [s.item, (s.end - s.start) / 60_000]);

test('completions: the in-tray of three, each given the time since the one before, from the start of the day', () => {
  // Three reviews finished at 09:20, 09:40, 10:00.
  assert.deepEqual(mins(completionSpans([done('a', 20, 'title_review'), done('b', 40, 'title_review'), done('c', 60, 'title_review')], RULES)), [['a', 20], ['b', 20], ['c', 20]]);
});

test('completions: routine work is capped at three times what it takes, legal work at three hours; lunch is never work', () => {
  // A chaser at 11:30 after nothing since 09:00: 15 minutes (three times 4, never under 15), not two and a half hours.
  assert.deepEqual(mins(completionSpans([done('c', 150)], RULES)), [['c', 15]]);
  // A Land Registry application (typically 25 minutes): up to 75.
  assert.deepEqual(mins(completionSpans([done('l', 150, 'land_registry_applications')], RULES)), [['l', 75]]);
  // A title review at 12:00 after 09:00: three hours.
  assert.deepEqual(mins(completionSpans([done('t', 180, 'title_review')], RULES)), [['t', 180]]);
  // A review done 12:30 then one finished 14:30 (BST): 13:00–14:00 is lunch, so the second is 30 + 30 minutes.
  const sp = completionSpans([done('a', 210, 'title_review'), done('b', 330, 'title_review')], RULES);
  assert.deepEqual(mins(sp).filter(([i]) => i === 'b'), [['b', 30], ['b', 30]]);
});

test('completions: a run of approvals in one sitting shares the time before it', () => {
  // Nothing since 10:00; five chasers approved 10:30:00–10:30:40.
  const ev = [done('x', 60), ...[0, 10, 20, 30, 40].map((sec, n) => ({ at: at(90) + sec * 1000, item: `c${n}`, kind: 'client_chasers' as const }))];
  const sp = completionSpans(ev, RULES).filter((s) => s.item.startsWith('c'));
  assert.equal(sp.length, 5);
  for (const s of sp) assert.ok(Math.abs((s.end - s.start) / 60_000 - 30.6667 / 5) < 0.01);
});

test('completions out of hours are kept (they count as after hours) and capped', () => {
  // A client update at 21:00 after the last thing at 17:00: three times 7 minutes, not four hours.
  assert.deepEqual(mins(completionSpans([done('a', 480, 'filing'), done('late', 720, 'client_updates')], RULES)).filter(([i]) => i === 'late'), [['late', 21]]);
});

test('quick emails sent in the middle of legal work keep their own minutes, and the legal work keeps the rest', () => {
  const done: Completion[] = [
    { at: at(60), item: 'chase', kind: 'client_chasers' }, // 10:00, a chaser sent mid-report
    { at: at(120), item: 'ack', kind: 'acknowledging' }, // 11:00, an acknowledgement
    { at: at(150), item: 'rot', kind: 'report_on_title' }, // 11:30, the report goes out
  ];
  const sl = attribute(completionSpans(done, { ...DAY, ...DEFAULT_LUNCH }));
  const mins = (item: string) => sl.filter((s) => s.span.item === item).reduce((a, s) => a + (s.end - s.start) / 60_000, 0);
  // Each quick email: its capped minutes just before it. The report: everything else since 09:00, through them.
  const chase = mins('chase');
  const ack = mins('ack');
  assert.ok(chase > 0 && chase < 60 && ack > 0 && ack < 60);
  assert.equal(Math.round(mins('rot') + chase + ack), 150);
  // Not the old reading, where the report was given only the half hour since the acknowledgement.
  assert.ok(mins('rot') > 30);
});
