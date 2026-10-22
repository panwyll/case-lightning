/**
 * The demo diary: when a demo can be booked (lib/server/demo/slots.ts), the host's busy times read from a
 * published calendar, and the invite that puts a booking in both diaries (lib/server/demo/ics.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoSlots, DEMO_HOURS } from '../../../lib/server/demo/slots';
import { busyFromIcs, inviteIcs } from '../../../lib/server/demo/ics';
import { zonedTime, wallClock } from '../../../lib/server/demo/time';

const london = (iso: string) => { const [d, t] = iso.split('T'); const [y, m, dd] = d.split('-').map(Number); const [h, mi] = t.split(':').map(Number); return zonedTime(y, m, dd, h, mi, 'Europe/London'); };
const hhmm = (iso: string) => { const w = wallClock(new Date(iso), 'Europe/London'); return `${String(w.h).padStart(2, '0')}:${String(w.min).padStart(2, '0')}`; };

test('London time: summer and winter both land on the right instant', () => {
  assert.equal(london('2026-07-01T10:00').toISOString(), '2026-07-01T09:00:00.000Z');
  assert.equal(london('2026-12-01T10:00').toISOString(), '2026-12-01T10:00:00.000Z');
});

test('slots: working hours on working days, every half hour, after two hours notice; weekends and bank holidays are not offered', () => {
  // Thursday 22 October 2026, 08:00 in London.
  const days = demoSlots(london('2026-10-22T08:00'), []);
  assert.equal(days[0].date, '2026-10-22');
  assert.equal(hhmm(days[0].times[0]), '10:00', 'two hours notice from 08:00 is 10:00');
  assert.equal(hhmm(days[0].times.at(-1)!), DEMO_HOURS.last);
  assert.ok(!days.some((d) => ['2026-10-24', '2026-10-25'].includes(d.date)), 'no weekend');
  const dec = demoSlots(london('2026-12-21T08:00'), []);
  assert.ok(!dec.some((d) => ['2026-12-25', '2026-12-28'].includes(d.date)), 'no bank holidays');
  // Across the clock change (25 October 2026): Monday 26th still starts at 09:30 London time.
  const mon = days.find((d) => d.date === '2026-10-26')!;
  assert.equal(hhmm(mon.times[0]), '09:30');
  assert.equal(mon.times[0], '2026-10-26T09:30:00.000Z', 'GMT after the change');
});

test('slots: anything in the diary takes out the slots it overlaps, and only those', () => {
  const now = london('2026-10-22T08:00');
  const busy = [{ start: london('2026-10-23T11:00'), end: london('2026-10-23T12:00') }];
  const fri = demoSlots(now, busy).find((d) => d.date === '2026-10-23')!.times.map(hhmm);
  assert.ok(!fri.includes('11:00') && !fri.includes('11:30'));
  assert.ok(fri.includes('10:30') && fri.includes('12:00'), fri.join(' '));
});

const cal = (events: string) => ['BEGIN:VCALENDAR', 'VERSION:2.0', events.trim(), 'END:VCALENDAR'].join('\r\n');

test('published calendar: timed, all-day, Windows time zones, free time and cancelled events', () => {
  const ics = cal(`
BEGIN:VEVENT
UID:a
DTSTART;TZID=GMT Standard Time:20261023T110000
DTEND;TZID=GMT Standard Time:20261023T120000
END:VEVENT
BEGIN:VEVENT
UID:b
DTSTART;VALUE=DATE:20261027
DTEND;VALUE=DATE:20261028
END:VEVENT
BEGIN:VEVENT
UID:c
DTSTART:20261023T140000Z
DTEND:20261023T150000Z
TRANSP:TRANSPARENT
END:VEVENT
BEGIN:VEVENT
UID:d
DTSTART:20261023T150000Z
DTEND:20261023T160000Z
STATUS:CANCELLED
END:VEVENT
BEGIN:VEVENT
UID:e
DTSTART;TZID=W. Europe Standard Time:20261023T090000
DURATION:PT30M
END:VEVENT`);
  const busy = busyFromIcs(ics, london('2026-10-22T00:00'), london('2026-11-05T00:00'));
  const got = busy.map((b) => `${b.start.toISOString()}/${b.end.toISOString()}`).sort();
  assert.deepEqual(got, [
    '2026-10-23T07:00:00.000Z/2026-10-23T07:30:00.000Z', // 09:00 Berlin (summer time)
    '2026-10-23T10:00:00.000Z/2026-10-23T11:00:00.000Z', // 11:00 London (summer time)
    '2026-10-27T00:00:00.000Z/2026-10-28T00:00:00.000Z', // all day Tuesday
  ]);
});

test('published calendar: a weekly repeat keeps its London time across the clock change, with a skipped week and a moved one', () => {
  const ics = cal(`
BEGIN:VEVENT
UID:weekly
DTSTART;TZID=Europe/London:20261005T100000
DTEND;TZID=Europe/London:20261005T110000
RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261231T235959Z
EXDATE;TZID=Europe/London:20261028T100000
END:VEVENT
BEGIN:VEVENT
UID:weekly
RECURRENCE-ID;TZID=Europe/London:20261026T100000
DTSTART;TZID=Europe/London:20261026T150000
DTEND;TZID=Europe/London:20261026T160000
END:VEVENT`);
  const busy = busyFromIcs(ics, london('2026-10-22T00:00'), london('2026-11-03T00:00')).map((b) => b.start.toISOString()).sort();
  assert.deepEqual(busy, [
    '2026-10-26T15:00:00.000Z', // Monday moved to 15:00 (GMT now)
    '2026-11-02T10:00:00.000Z', // the next Monday at 10:00 London, GMT
  ], 'Wednesday 28th skipped; Monday 26th at its new time only');
});

test('the invite: one event both diaries accept, and its cancellation', () => {
  const base = { uid: 'demo-1@caselightning.co.uk', start: new Date('2026-10-23T09:30:00Z'), end: new Date('2026-10-23T09:45:00Z'), summary: 'CONVEYi demo, Example LLP', description: 'Line one\nLine two, with a comma; and a semicolon', location: 'https://meet.example.test/pete', organizer: { name: 'Pete Anwyll', email: 'pete@caselightning.co.uk' }, attendees: [{ name: 'Jane Smith', email: 'jane@example.test' }] };
  const ics = inviteIcs({ ...base, method: 'REQUEST', sequence: 0 });
  assert.match(ics, /METHOD:REQUEST/);
  assert.match(ics, /DTSTART:20261023T093000Z/);
  assert.match(ics, /DESCRIPTION:Line one\\nLine two\\, with a comma\; and a semicolon/);
  assert.ok(ics.split('\r\n').every((l) => Buffer.byteLength(l) <= 75), 'lines folded');
  const cancel = inviteIcs({ ...base, method: 'CANCEL', sequence: 1 });
  assert.match(cancel, /METHOD:CANCEL/);
  assert.match(cancel, /STATUS:CANCELLED/);
  assert.match(cancel, /UID:demo-1@caselightning.co.uk/);
});
