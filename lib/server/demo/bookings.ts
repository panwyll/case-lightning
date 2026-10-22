/**
 * Demo bookings (migration 138): the slots on offer, booking one, cancelling one. A booking is saved first; then
 * the person and the host are each emailed a calendar invite, so it lands in both diaries without either calendar
 * being connected to us. The host's own busy times come from their published calendar (DEMO_BUSY_ICS_URL); if
 * that cannot be read, slots are offered anyway and bookings alone are kept clear.
 */
import crypto from 'node:crypto';
import { Resend } from 'resend';
import { query, queryOne, runAsSystem } from '../db';
import { config } from '../config';
import { busyFromIcs, inviteIcs } from './ics';
import { DEMO_HOURS, demoSlots, type Busy, type SlotDay } from './slots';

const env = (k: string) => process.env[k]?.trim() || undefined;

export const DEMO_HOST = {
  name: env('DEMO_HOST_NAME') ?? 'Pete Anwyll',
  email: env('DEMO_HOST_EMAIL') ?? 'pete@caselightning.co.uk',
};
/** The video link every demo uses. Without one, the demo is a phone call and a phone number is required. */
export const DEMO_MEETING_URL = env('DEMO_MEETING_URL') ?? null;

export class DemoBookingError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

const hash = (x: string) => crypto.createHash('sha256').update(x).digest('hex');

let feed: { at: number; busy: Busy[] } | null = null;

/** The host's busy times from their published calendar, read at most every five minutes. */
async function hostBusy(now: Date): Promise<Busy[]> {
  const url = env('DEMO_BUSY_ICS_URL');
  if (!url) return [];
  if (feed && now.getTime() - feed.at < 5 * 60_000) return feed.busy;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(6000), cache: 'no-store' });
    if (!r.ok) throw new Error(`calendar feed ${r.status}`);
    const to = new Date(now.getTime() + (DEMO_HOURS.horizonDays + 2) * 86_400_000);
    feed = { at: now.getTime(), busy: busyFromIcs(await r.text(), now, to, DEMO_HOURS.tz) };
    return feed.busy;
  } catch (e) {
    console.error('demo busy feed failed', e);
    return feed?.busy ?? [];
  }
}

async function booked(now: Date): Promise<Busy[]> {
  const rows = await runAsSystem(() => query<{ starts_at: Date; ends_at: Date }>(
    `select starts_at, ends_at from demo_booking where status = 'booked' and ends_at > $1`, [now]));
  return rows.map((r) => ({ start: new Date(r.starts_at), end: new Date(r.ends_at) }));
}

/** Every start still free, by day. */
export async function availableSlots(now = new Date()): Promise<SlotDay[]> {
  const [mine, host] = await Promise.all([booked(now), hostBusy(now)]);
  return demoSlots(now, [...mine, ...host]);
}

const when = (at: Date) => new Intl.DateTimeFormat('en-GB', { timeZone: DEMO_HOURS.tz, weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', hour12: true }).format(at).replace(' at ', ', ').replace(/\s(am|pm)/, '$1');

/** The address we send from, and who the invite says it is from. */
function sender() {
  const from = config.resendFromEmail;
  if (!config.resendApiKey || !from) return null;
  const email = from.match(/<([^>]+)>/)?.[1] ?? from;
  return { resend: new Resend(config.resendApiKey), from, email };
}

interface Row {
  id: string; name: string; email: string; firm: string; phone: string | null; fee_earners: string | null; note: string | null;
  starts_at: Date; ends_at: Date; status: 'booked' | 'cancelled'; sequence: number; source: Record<string, string>;
}

function invite(b: Row, method: 'REQUEST' | 'CANCEL', organizerEmail: string) {
  const where = DEMO_MEETING_URL ?? `Phone call: ${DEMO_HOST.name} calls ${b.phone}`;
  return inviteIcs({
    method,
    uid: `demo-${b.id}@caselightning.co.uk`,
    sequence: b.sequence,
    start: new Date(b.starts_at),
    end: new Date(b.ends_at),
    summary: `CONVEYi demo: ${b.firm}`,
    description: [`${DEMO_HOST.name} (Case Lightning) and ${b.name} (${b.firm}).`, DEMO_MEETING_URL ? `Join: ${DEMO_MEETING_URL}` : `${DEMO_HOST.name} calls ${b.phone}.`].join('\n'),
    location: where,
    organizer: { name: 'Case Lightning', email: organizerEmail },
    attendees: [{ name: DEMO_HOST.name, email: DEMO_HOST.email }, { name: b.name, email: b.email }],
  });
}

async function send(b: Row, method: 'REQUEST' | 'CANCEL', cancelUrl: string | null) {
  const s = sender();
  if (!s) return;
  const ics = invite(b, method, s.email);
  const attachment = [{ filename: method === 'CANCEL' ? 'cancel.ics' : 'invite.ics', content: Buffer.from(ics), contentType: `text/calendar; charset=utf-8; method=${method}` }];
  const at = when(new Date(b.starts_at));
  const first = b.name.split(/\s+/)[0];
  const how = DEMO_MEETING_URL ? `Join here: ${DEMO_MEETING_URL}` : `${DEMO_HOST.name.split(' ')[0]} will call you on ${b.phone}.`;
  const theirs = method === 'REQUEST'
    ? { subject: `CONVEYi demo, ${at}`, text: `Hi ${first},\n\nYou are booked in for a 15-minute CONVEYi demo on ${at} (UK time). The invite is attached.\n\n${how}\n\nCan no longer make it? Cancel here: ${cancelUrl}\n\n${DEMO_HOST.name}\nCase Lightning` }
    : { subject: `Cancelled: CONVEYi demo, ${at}`, text: `Hi ${first},\n\nYour CONVEYi demo on ${at} is cancelled. Book another time whenever suits: ${config.appUrl}/conveyi/demo\n\n${DEMO_HOST.name}\nCase Lightning` };
  const source = Object.entries(b.source ?? {}).map(([k, v]) => `${k}=${v}`).join(' ');
  const host = method === 'REQUEST'
    ? { subject: `Demo booked: ${b.firm}, ${at}`, text: [`${b.name} <${b.email}>`, b.firm, b.phone && `Phone: ${b.phone}`, b.fee_earners && `Fee earners: ${b.fee_earners}`, b.note && `\n${b.note}`, source && `\nCame from: ${source}`, `\nCancel it: ${cancelUrl}`].filter(Boolean).join('\n') }
    : { subject: `Demo cancelled: ${b.firm}, ${at}`, text: `${b.name} <${b.email}>, ${b.firm}, cancelled the demo on ${at}.` };
  await Promise.all([
    s.resend.emails.send({ from: s.from, to: b.email, replyTo: DEMO_HOST.email, subject: theirs.subject, text: theirs.text, attachments: attachment }).catch((e) => console.error('demo email to booker failed', e)),
    s.resend.emails.send({ from: s.from, to: DEMO_HOST.email, replyTo: b.email, subject: host.subject, text: host.text, attachments: attachment }).catch((e) => console.error('demo email to host failed', e)),
  ]);
}

export interface BookingInput { start: string; name: string; email: string; firm: string; phone: string; feeEarners: string; note: string; source: Record<string, string> }

/** Book a start that is still free. Two people picking the same one at once: the second is told it has gone. */
export async function bookDemo(input: BookingInput, now = new Date()): Promise<{ start: string; end: string }> {
  if (!DEMO_MEETING_URL && !input.phone) throw new DemoBookingError('A phone number, so we can call you.', 400);
  const start = new Date(input.start);
  const free = (await availableSlots(now)).some((d) => d.times.includes(start.toISOString()));
  if (!free) throw new DemoBookingError('That time has just gone. Please pick another.', 409);
  const email = input.email.toLowerCase();
  const recent = await runAsSystem(() => queryOne<{ n: number }>(
    `select count(*)::int as n from demo_booking where lower(email) = $1 and (created_at > now() - interval '1 day' or (status = 'booked' and ends_at > now()))`, [email]));
  if ((recent?.n ?? 0) >= 3) throw new DemoBookingError(`You already have demos booked. Email ${DEMO_HOST.email} to change one.`, 429);
  const token = crypto.randomBytes(24).toString('base64url');
  const end = new Date(start.getTime() + DEMO_HOURS.minutes * 60_000);
  let row: Row | null;
  try {
    row = await runAsSystem(() => queryOne<Row>(
      `insert into demo_booking (name, email, firm, phone, fee_earners, note, starts_at, ends_at, cancel_token_hash, source)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb) returning *`,
      [input.name, email, input.firm, input.phone || null, input.feeEarners || null, input.note || null, start, end, hash(token), JSON.stringify(input.source)]));
  } catch (e) {
    if ((e as { code?: string })?.code === '23505') throw new DemoBookingError('That time has just gone. Please pick another.', 409);
    throw e;
  }
  if (row) await send(row, 'REQUEST', `${config.appUrl}/conveyi/demo/cancel/${token}`);
  return { start: start.toISOString(), end: end.toISOString() };
}

export interface BookingView { start: string; firm: string; name: string; status: 'booked' | 'cancelled' | 'past' }

/** What a cancel link points at, or null for a link that never existed. */
export async function bookingByToken(token: string): Promise<BookingView | null> {
  if (!/^[\w-]{20,64}$/.test(token)) return null;
  const b = await runAsSystem(() => queryOne<Row>(`select * from demo_booking where cancel_token_hash = $1`, [hash(token)]));
  if (!b) return null;
  const past = new Date(b.starts_at).getTime() <= Date.now();
  return { start: new Date(b.starts_at).toISOString(), firm: b.firm, name: b.name, status: b.status === 'booked' && past ? 'past' : b.status };
}

/** Cancel from the link in either email. Both diaries are sent the cancellation. */
export async function cancelDemo(token: string): Promise<BookingView> {
  if (!/^[\w-]{20,64}$/.test(token)) throw new DemoBookingError('This link is not one of ours.', 404);
  const b = await runAsSystem(() => queryOne<Row>(
    `update demo_booking set status = 'cancelled', cancelled_at = now(), sequence = sequence + 1
     where cancel_token_hash = $1 and status = 'booked' and starts_at > now() returning *`, [hash(token)]));
  if (b) await send(b, 'CANCEL', null);
  const view = await bookingByToken(token);
  if (!view) throw new DemoBookingError('This link is not one of ours.', 404);
  return view;
}
