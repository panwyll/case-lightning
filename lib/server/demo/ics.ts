/**
 * Calendar files (RFC 5545), the two things the demo diary needs:
 *   - busy times out of the host's published calendar (Outlook: Settings > Calendar > Shared calendars > Publish,
 *     "Can view when I'm busy"), so nobody books over a meeting; and
 *   - the invite (and its cancellation) that puts a booking in both diaries.
 * Reading covers what a published Outlook or Google calendar contains: timed and all-day events, time zones by
 * IANA or Windows name, daily/weekly/monthly repeats with an interval, an end date or a count, skipped dates and
 * moved occurrences. Anything marked free, tentative-free or cancelled is not busy.
 */
import { knownZone, wallClock, zonedTime } from './time';
import type { Busy } from './slots';

/** Windows zone names Outlook writes in TZID, to their IANA zone. */
const WINDOWS_TZ: Record<string, string> = {
  'GMT Standard Time': 'Europe/London', 'Greenwich Standard Time': 'Atlantic/Reykjavik', 'UTC': 'UTC', 'Coordinated Universal Time': 'UTC',
  'W. Europe Standard Time': 'Europe/Berlin', 'Romance Standard Time': 'Europe/Paris', 'Central Europe Standard Time': 'Europe/Budapest',
  'Central European Standard Time': 'Europe/Warsaw', 'GTB Standard Time': 'Europe/Bucharest', 'E. Europe Standard Time': 'Europe/Chisinau',
  'Eastern Standard Time': 'America/New_York', 'Central Standard Time': 'America/Chicago', 'Mountain Standard Time': 'America/Denver',
  'Pacific Standard Time': 'America/Los_Angeles', 'India Standard Time': 'Asia/Kolkata', 'Singapore Standard Time': 'Asia/Singapore',
  'AUS Eastern Standard Time': 'Australia/Sydney',
};

interface Prop { name: string; params: Record<string, string>; value: string }

/** Lines unfolded (a line starting with a space or tab continues the one before) and split into properties. */
function props(text: string): Prop[] {
  const lines = text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  return lines.filter(Boolean).map((line) => {
    const colon = line.search(/:(?=(?:[^"]*"[^"]*")*[^"]*$)/);
    const head = colon >= 0 ? line.slice(0, colon) : line;
    const value = colon >= 0 ? line.slice(colon + 1) : '';
    const [name, ...ps] = head.split(';');
    return { name: name.toUpperCase(), params: Object.fromEntries(ps.map((p) => { const i = p.indexOf('='); return [p.slice(0, i).toUpperCase(), p.slice(i + 1).replace(/^"|"$/g, '')]; })), value };
  });
}

interface When { at: Date; allDay: boolean; tz: string }

function when(p: Prop, hostTz: string): When | null {
  const v = p.value.trim();
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(v);
  if (!m) return null;
  const [, y, mo, d, h, mi, , z] = m;
  if (!h) return { at: zonedTime(+y, +mo, +d, 0, 0, hostTz), allDay: true, tz: hostTz };
  if (z) return { at: new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi)), allDay: false, tz: 'UTC' };
  const tzid = p.params.TZID ? (WINDOWS_TZ[p.params.TZID] ?? (knownZone(p.params.TZID) ? p.params.TZID : hostTz)) : hostTz;
  return { at: zonedTime(+y, +mo, +d, +h, +mi, tzid), allDay: false, tz: tzid };
}

/** "PT1H30M", "P1D", "P1DT2H" in milliseconds. */
function duration(v: string): number | null {
  const m = /^(-)?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m) return null;
  const [, , w, d, h, mi, s] = m;
  return ((+(w ?? 0) * 7 + +(d ?? 0)) * 86_400 + +(h ?? 0) * 3600 + +(mi ?? 0) * 60 + +(s ?? 0)) * 1000;
}

const DAYS: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

/**
 * The start of every occurrence of a repeating event, in the event's own zone so a weekly 9am stays 9am across
 * a clock change. Starts from the first occurrence (a COUNT counts from there) and stops past `to`.
 */
function occurrences(start: When, rrule: string, to: Date): Date[] {
  const r = Object.fromEntries(rrule.split(';').map((x) => x.split('=')).map(([k, v]) => [k.toUpperCase(), v]));
  const freq = r.FREQ;
  if (!['DAILY', 'WEEKLY', 'MONTHLY'].includes(freq)) return [start.at];
  const interval = Math.max(1, +(r.INTERVAL ?? 1));
  const count = r.COUNT ? +r.COUNT : Infinity;
  const until = r.UNTIL ? when({ name: 'UNTIL', params: {}, value: r.UNTIL }, start.tz)?.at ?? null : null;
  const s = wallClock(start.at, start.tz);
  const byDay = (r.BYDAY ?? '').split(',').map((x) => DAYS[x.replace(/^[+-]?\d+/, '')]).filter((x) => x !== undefined);
  const days = freq === 'WEEKLY' && byDay.length ? byDay : [s.dow];
  const out: Date[] = [];
  // Weeks are counted from the Monday of the first occurrence's week (WKST=MO, Outlook's and Google's default).
  const weekStart = Date.UTC(s.y, s.m - 1, s.d) - ((s.dow + 6) % 7) * 86_400_000;
  for (let i = 0, n = 0; i < 3700 && n < count; i++) {
    const day = new Date(Date.UTC(s.y, s.m - 1, s.d + i));
    const w = { y: day.getUTCFullYear(), m: day.getUTCMonth() + 1, d: day.getUTCDate(), dow: day.getUTCDay() };
    let hit = false;
    if (freq === 'DAILY') hit = i % interval === 0;
    else if (freq === 'WEEKLY') hit = days.includes(w.dow) && Math.floor((day.getTime() - weekStart) / (7 * 86_400_000)) % interval === 0;
    else hit = w.d === s.d && ((w.y - s.y) * 12 + (w.m - s.m)) % interval === 0;
    if (!hit) continue;
    const at = start.allDay ? zonedTime(w.y, w.m, w.d, 0, 0, start.tz) : zonedTime(w.y, w.m, w.d, s.h, s.min, start.tz);
    if (until && at > until) break;
    if (at > to) break;
    out.push(at);
    n++;
  }
  return out;
}

/** The busy intervals between `from` and `to` in a published calendar. */
export function busyFromIcs(text: string, from: Date, to: Date, hostTz = 'Europe/London'): Busy[] {
  const all = props(text);
  const events: Prop[][] = [];
  let cur: Prop[] | null = null;
  for (const p of all) {
    if (p.name === 'BEGIN' && p.value.toUpperCase() === 'VEVENT') cur = [];
    else if (p.name === 'END' && p.value.toUpperCase() === 'VEVENT') { if (cur) events.push(cur); cur = null; }
    else if (cur) cur.push(p);
  }
  const get = (e: Prop[], n: string) => e.find((p) => p.name === n);
  const free = (e: Prop[]) => /^TRANSPARENT$/i.test(get(e, 'TRANSP')?.value ?? '') || /^CANCELLED$/i.test(get(e, 'STATUS')?.value ?? '') || /^(FREE|WORKINGELSEWHERE)$/i.test(get(e, 'X-MICROSOFT-CDO-BUSYSTATUS')?.value ?? '');
  // A moved or changed occurrence (RECURRENCE-ID) replaces the one the rule would have made.
  const moved = new Map<string, Set<number>>();
  for (const e of events) {
    const rid = get(e, 'RECURRENCE-ID');
    const uid = get(e, 'UID')?.value;
    const at = rid ? when(rid, hostTz)?.at : null;
    if (uid && at) moved.set(uid, (moved.get(uid) ?? new Set()).add(at.getTime()));
  }
  const out: Busy[] = [];
  for (const e of events) {
    const dtstart = get(e, 'DTSTART');
    const start = dtstart ? when(dtstart, hostTz) : null;
    if (!start || free(e)) continue;
    const dtend = get(e, 'DTEND');
    const end = dtend ? when(dtend, hostTz)?.at : null;
    const dur = get(e, 'DURATION');
    const length = end ? end.getTime() - start.at.getTime() : dur ? duration(dur.value) ?? 0 : start.allDay ? 86_400_000 : 0;
    if (length <= 0) continue;
    const rrule = get(e, 'RRULE')?.value;
    const isOverride = !!get(e, 'RECURRENCE-ID');
    const skip = new Set<number>([...e.filter((p) => p.name === 'EXDATE').flatMap((p) => p.value.split(',').map((v) => when({ ...p, value: v }, hostTz)?.at.getTime() ?? -1)), ...(!isOverride ? moved.get(get(e, 'UID')?.value ?? '') ?? [] : [])]);
    const starts = rrule && !isOverride ? occurrences(start, rrule, to) : [start.at];
    for (const s of starts) {
      if (skip.has(s.getTime())) continue;
      const busy = { start: s, end: new Date(s.getTime() + length) };
      if (busy.end > from && busy.start < to) out.push(busy);
    }
  }
  return out;
}

const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
/** Lines over 75 octets folded, as the format requires. */
const fold = (line: string) => { const out: string[] = []; let rest = line; while (Buffer.byteLength(rest) > 75) { let n = 74; while (Buffer.byteLength(rest.slice(0, n)) > 74) n--; out.push(rest.slice(0, n)); rest = ` ${rest.slice(n)}`; } out.push(rest); return out.join('\r\n'); };

export interface Invite {
  method: 'REQUEST' | 'CANCEL';
  uid: string;
  sequence: number;
  start: Date;
  end: Date;
  summary: string;
  description: string;
  location: string;
  organizer: { name: string; email: string };
  attendees: Array<{ name: string | null; email: string }>;
}

/** The invite (or its cancellation) as a calendar file every mail client turns into an Accept button. */
export function inviteIcs(i: Invite, now = new Date()): string {
  const lines = [
    'BEGIN:VCALENDAR', 'PRODID:-//Case Lightning//CONVEYi demo//EN', 'VERSION:2.0', 'CALSCALE:GREGORIAN', `METHOD:${i.method}`,
    'BEGIN:VEVENT', `UID:${i.uid}`, `SEQUENCE:${i.sequence}`, `DTSTAMP:${stamp(now)}`, `DTSTART:${stamp(i.start)}`, `DTEND:${stamp(i.end)}`,
    `SUMMARY:${esc(i.summary)}`, `DESCRIPTION:${esc(i.description)}`, `LOCATION:${esc(i.location)}`,
    `ORGANIZER;CN=${esc(i.organizer.name)}:mailto:${i.organizer.email}`,
    ...i.attendees.map((a) => `ATTENDEE;${a.name ? `CN=${esc(a.name)};` : ''}ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${a.email}`),
    `STATUS:${i.method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED'}`, 'TRANSP:OPAQUE',
    ...(i.method === 'REQUEST' ? ['BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', 'TRIGGER:-PT10M', 'END:VALARM'] : []),
    'END:VEVENT', 'END:VCALENDAR',
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}
