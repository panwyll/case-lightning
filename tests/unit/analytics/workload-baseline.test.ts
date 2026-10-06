/** The workload baseline (docs/workload-baseline.md): every figure from the rows and the settings, checkable by hand. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, correctCounts, drawSample, inWorkingHours, median, timedMinutes, wilson, workingWeeks, type Row } from '../../../lib/server/workload/model';
import { allInternal, filterByRule, wordCount, writtenText } from '../../../lib/server/workload/taxonomy';

const row = (p: Partial<Row>): Row => ({ direction: 'out', category: 'chaser', filtered: null, sentAt: '2026-09-15T10:00:00Z', draftedAt: null, wordsWritten: 40, inSample: false, checkedCategory: null, ...p });

test('the written text stops at the sign-off, the signature, the disclaimer and a quoted thread', () => {
  const body = 'Hi Sam,\n\nCould you send the TA6 please? We need it to issue the contract.\n\nKind regards,\nPat Lee\nSenior Conveyancer\nTest & Co\n\nThis email and any attachments are confidential.';
  assert.equal(writtenText(body), 'Hi Sam,\n\nCould you send the TA6 please? We need it to issue the contract.\n\nKind regards,');
  assert.equal(writtenText('Thanks, received.\n\nOn Tue, 3 Sep 2026 at 10:01, Sam wrote:\n> the forms'), 'Thanks, received.');
  assert.equal(writtenText('Noted.\nFrom: Sam <s@x.com>\nSent: today'), 'Noted.');
  assert.equal(wordCount('Could you send the TA6 — £250,000?'), 6);
  assert.equal(wordCount(''), 0);
});

test('automated, bulk, calendar, out-of-office and empty messages are set aside by rule', () => {
  const m = { direction: 'in' as const, from: 'x@firm.com', subject: 'Re: 14 Oak Street', text: 'Any news?', hasAttachments: false };
  assert.equal(filterByRule(m), null);
  assert.equal(filterByRule({ ...m, from: 'no-reply@portal.example' }), 'automated');
  assert.equal(filterByRule({ ...m, from: 'notifications@lender.example' }), 'automated');
  assert.equal(filterByRule({ ...m, text: 'Our news. Unsubscribe here.' }), 'bulk');
  assert.equal(filterByRule({ ...m, subject: 'Accepted: completion call' }), 'calendar');
  assert.equal(filterByRule({ ...m, subject: 'Automatic reply: away' }), 'auto_reply');
  assert.equal(filterByRule({ ...m, direction: 'out', text: '', hasAttachments: true }), null, 'a file sent with no words is still a file sent');
  assert.equal(filterByRule({ ...m, direction: 'out', text: '' }), 'empty');
  assert.equal(filterByRule({ ...m, direction: 'out', from: 'no-reply@x.com' }), null, 'our own sent mail is never "automated" by sender');
  assert.equal(allInternal(['a@firm.co.uk', 'B@Firm.co.uk'], ['firm.co.uk']), true);
  assert.equal(allInternal(['a@firm.co.uk', 'client@gmail.com'], ['firm.co.uk']), false);
});

test('statistics: Wilson interval, median, and counts corrected by the checked sample', () => {
  const ci = wilson(47, 50)!;
  assert.ok(Math.abs(ci.low - 0.838) < 0.005 && Math.abs(ci.high - 0.979) < 0.005, JSON.stringify(ci));
  assert.equal(wilson(0, 0), null);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  // 10 checked chasers: 8 chasers, 2 status updates (overall agreement 0.8, every mistake a status update).
  // Prior of 5: 4 agree, 1 status update. Chasers: 100 × (8 + 4) / 15 = 80; 20 move to status updates.
  // Status updates had none checked: they follow the overall 0.8, but the mistakes seen were all "really a
  // status update", which a status update cannot be mistaken for, so they stay as they are.
  const cats = ['chaser', 'status_update'] as const;
  const checked = [...Array(8).fill({ given: 'chaser', truth: 'chaser' }), ...Array(2).fill({ given: 'chaser', truth: 'status_update' })];
  const c = correctCounts({ chaser: 100, status_update: 50 }, checked, cats);
  assert.ok(Math.abs(c.chaser - 80) < 1e-9, String(c.chaser));
  assert.ok(Math.abs(c.status_update - 70) < 1e-9, String(c.status_update));
  assert.ok(Math.abs(c.chaser + c.status_update - 150) < 1e-9, 'nothing is gained or lost');
  // One checked first request that was wrong does not move half the category: it is shrunk to the overall rate.
  const many = [...Array(45).fill({ given: 'chaser', truth: 'chaser' }), ...Array(4).fill({ given: 'chaser', truth: 'legal_work' }), { given: 'first_request', truth: 'legal_work' }];
  const cats3 = ['chaser', 'first_request', 'legal_work'] as const;
  const d = correctCounts({ chaser: 300, first_request: 100, legal_work: 150 }, many, cats3);
  // Its own sample alone would make all 100 legal work; shrunk: 100 × (0 + 5 × 0.9) / (1 + 5) = 75 stay first requests.
  assert.ok(Math.abs(d.first_request - 75) < 1e-9, String(d.first_request));
  assert.ok(Math.abs(d.chaser + d.first_request + d.legal_work - 550) < 1e-9);
});

test('time: a draft is a timing only between 15 seconds and 45 minutes; working hours are UK time on working days', () => {
  assert.equal(timedMinutes({ draftedAt: '2026-09-15T10:00:00Z', sentAt: '2026-09-15T10:06:00Z' }), 6);
  assert.equal(timedMinutes({ draftedAt: '2026-09-15T10:00:00Z', sentAt: '2026-09-15T10:00:05Z' }), null);
  assert.equal(timedMinutes({ draftedAt: '2026-09-15T08:00:00Z', sentAt: '2026-09-15T10:00:00Z' }), null);
  assert.equal(timedMinutes({ draftedAt: null, sentAt: '2026-09-15T10:00:00Z' }), null);
  const day = { workdayStart: '09:00', workdayEnd: '17:30' };
  assert.equal(inWorkingHours('2026-09-15T08:30:00Z', day), true, '09:30 BST on a Tuesday');
  assert.equal(inWorkingHours('2026-09-15T17:00:00Z', day), false, '18:00 BST');
  assert.equal(inWorkingHours('2026-09-19T10:00:00Z', day), false, 'a Saturday');
  assert.equal(inWorkingHours('2026-12-25T10:00:00Z', day), false, 'Christmas Day');
  assert.equal(inWorkingHours('2026-12-15T09:15:00Z', day), true, '09:15 GMT in winter');
  assert.equal(workingWeeks('2026-09-06T00:00:00Z', '2026-10-04T00:00:00Z'), 4, 'four working weeks');
});

test('the report: per week, minutes by basis, share of the week, after hours, and the money', () => {
  const since = '2026-09-06T00:00:00Z';
  const until = '2026-10-04T00:00:00Z'; // 4 working weeks
  const rows: Row[] = [
    // 40 chasers of 40 words, 12 timed at 5 minutes: timed basis.
    ...Array.from({ length: 40 }, (_, i) => row({ category: 'chaser', wordsWritten: 40, draftedAt: i < 12 ? '2026-09-15T09:55:00Z' : null })),
    // 20 status updates of 120 words, estimate 6 minutes: typing 3 + 6 = 9.
    ...Array.from({ length: 20 }, () => row({ category: 'status_update', wordsWritten: 120, sentAt: '2026-09-15T19:00:00Z' })),
    // 8 legal emails, no estimate: typing only.
    ...Array.from({ length: 8 }, () => row({ category: 'legal_work', wordsWritten: 400 })),
    // 4 scheduling emails of 80 words, estimate 4: drafted tier, only the typing (2 min) is freed.
    ...Array.from({ length: 4 }, () => row({ category: 'scheduling', wordsWritten: 80 })),
    row({ category: 'internal', wordsWritten: 30 }),
    row({ direction: 'in', category: 'update_request' }),
    row({ direction: 'in', category: null, filtered: 'bulk' }),
  ];
  const r = buildReport({ rows, since, until, estimates: { status_update: 6, scheduling: 4 }, settings: { hoursPerCompletion: 20, feePerCompletionPennies: 90_000, payPerCompletionPennies: 20_000 } });
  assert.equal(r.window.workingWeeks, 4);
  assert.deepEqual(r.read, { total: 75, sent: 73, received: 2, filtered: { bulk: 1 }, classified: 74 });
  const chaser = r.lines.find((l) => l.category === 'chaser')!;
  assert.equal(chaser.basis, 'timed');
  assert.equal(chaser.timed, 12);
  assert.equal(chaser.minutes, 5);
  assert.equal(chaser.perWeek, 10);
  assert.equal(chaser.hoursPerWeek, 0.83); // 10 × 5 / 60
  assert.equal(chaser.hoursPerWeekFloor, 0.17); // 10 × 1 / 60
  const status = r.lines.find((l) => l.category === 'status_update')!;
  assert.equal(status.basis, 'estimate');
  assert.equal(status.minutes, 9);
  assert.equal(status.hoursPerWeek, 0.75); // 5 a week × 9 / 60
  assert.equal(status.afterHours, 20, '20:00 BST is after hours');
  assert.equal(r.lines.find((l) => l.category === 'legal_work')!.basis, 'typing_only');
  // Freed: automated in full (0.833 + 0.75) + drafted typing only (1 a week × 2 min = 0.033).
  assert.equal(r.freed.hoursPerWeek, 1.6);
  assert.equal(r.freed.hoursPerMonth, 6.9); // 1.6 × 52 / 12, from the hours a week as shown
  assert.ok(Math.abs(r.freed.completionsPerMonth! - 0.35) < 0.01);
  assert.equal(r.freed.firmPerMonthPennies, Math.round(r.freed.completionsPerMonth! * 90_000));
  assert.equal(r.accuracy.rate, null, 'unchecked until the sample is checked');
  assert.equal(r.received.find((x) => x.category === 'update_request')!.count, 1);
  assert.ok(r.afterHoursShare! > 0.27 && r.afterHoursShare! < 0.28, String(r.afterHoursShare)); // 20 of 72 counted
});

test('a checked sample corrects the counts and reports agreement with its interval', () => {
  const rows: Row[] = [
    ...Array.from({ length: 45 }, () => row({ category: 'chaser', inSample: true, checkedCategory: 'chaser' })),
    ...Array.from({ length: 5 }, () => row({ category: 'chaser', inSample: true, checkedCategory: 'status_update' })),
    ...Array.from({ length: 50 }, () => row({ category: 'chaser' })),
  ];
  const r = buildReport({ rows, since: '2026-09-06T00:00:00Z', until: '2026-10-04T00:00:00Z' });
  assert.equal(r.accuracy.checked, 50);
  assert.equal(r.accuracy.agreed, 45);
  assert.equal(r.accuracy.rate, 0.9);
  assert.ok(r.accuracy.low! > 0.78 && r.accuracy.high! < 0.96);
  const c = r.lines.find((l) => l.category === 'chaser')!;
  assert.equal(c.count, 100);
  assert.ok(Math.abs(c.corrected - 90) < 0.05, String(c.corrected)); // (45 + 4.5) / 55 of 100
});

test('the sample is reproducible from the scan id', () => {
  const rows = Array.from({ length: 300 }, (_, i) => ({ id: String(i) }));
  const a = drawSample(rows, 50, 'scan-1').map((x) => x.id);
  assert.deepEqual(drawSample(rows, 50, 'scan-1').map((x) => x.id), a);
  assert.notDeepEqual(drawSample(rows, 50, 'scan-2').map((x) => x.id), a);
  assert.equal(new Set(a).size, 50);
});

test('what CONVEYi sent is put in the baseline categories', async () => {
  const { handoverCategory } = await import('../../../lib/server/workload/handover');
  assert.equal(handoverCategory('chase_sent', {}), 'chaser');
  assert.equal(handoverCategory('acknowledgement_sent', {}), 'acknowledgement');
  assert.equal(handoverCategory('request_sent', { template: 'request_contract_pack' }), 'first_request');
  assert.equal(handoverCategory('request_sent', { template: 'exchanged_agent' }), 'status_update');
  assert.equal(handoverCategory('client_update_sent', { template: 'deposit_request' }), 'first_request');
  assert.equal(handoverCategory('client_update_sent', { template: 'proof_of_funds_request_again' }), 'first_request');
  assert.equal(handoverCategory('client_update_sent', { template: 'completion_statement' }), 'file_send');
  assert.equal(handoverCategory('client_update_sent', { template: 'progress_update' }), 'status_update');
  assert.equal(handoverCategory('client_update_sent', { template: 'cp_mortgage_offer:seller_solicitor' }), 'status_update');
  assert.equal(handoverCategory('signing_pack_sent', {}), 'file_send');
  assert.equal(handoverCategory('enquiry_replies_sent', {}), null, 'legal work stays the conveyancer’s');
});

test('a Graph message is read as the scan keeps it: words written, timings, internal, filtered', async () => {
  const { stage } = await import('../../../lib/server/workload/scan');
  const sent = {
    id: 'AAMk1', isDraft: false, subject: 'RE: 14 Oak Street - contract pack', conversationId: 'c1', hasAttachments: false,
    createdDateTime: '2026-09-15T09:52:00Z', sentDateTime: '2026-09-15T10:00:00Z', receivedDateTime: '2026-09-15T10:00:01Z',
    from: { emailAddress: { name: 'Pat Lee', address: 'pat@testco.co.uk' } },
    toRecipients: [{ emailAddress: { name: 'Sam Smith', address: 'sam@otherside.law' } }], ccRecipients: [],
    uniqueBody: { content: 'Dear Sam,\n\nPlease could you send the draft contract pack? We are still waiting for it.\n\nKind regards,\nPat Lee\nTest & Co' },
  };
  const s = stage(sent, 'out', ['testco.co.uk'])!;
  assert.equal(s.words, 18, 'Dear Sam (2), the request (8), still waiting (6), Kind regards (2): not the signature');
  assert.equal(s.draftedAt, '2026-09-15T09:52:00Z');
  assert.equal(s.sentAt, '2026-09-15T10:00:00Z');
  assert.equal(s.isReply, true);
  assert.equal(s.internal, false);
  assert.equal(s.filtered, null);
  assert.match(s.people, /Sam Smith <otherside\.law>/);
  assert.doesNotMatch(s.people, /sam@/, 'names and domains only, never addresses');
  const internal = stage({ ...sent, toRecipients: [{ emailAddress: { name: 'Jo', address: 'jo@testco.co.uk' } }] }, 'out', ['testco.co.uk'])!;
  assert.equal(internal.internal, true);
  assert.equal(stage({ ...sent, isDraft: true }, 'out', []), null, 'a draft never sent is not a sent email');
  const news = stage({ ...sent, from: { emailAddress: { address: 'no-reply@portal.example' } }, receivedDateTime: '2026-09-15T08:00:00Z' }, 'in', [])!;
  assert.equal(news.filtered, 'automated');
  assert.equal(news.draftedAt, null, 'received mail has no draft time');
  assert.equal(news.sentAt, '2026-09-15T08:00:00Z');
});
