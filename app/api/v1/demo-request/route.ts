import { NextRequest } from 'next/server';
import { z } from 'zod';
import { Resend } from 'resend';
import { ok, fail } from '@/lib/server/http';
import { query, runAsSystem } from '@/lib/server/db';
import { firstTouch, firstTouchTags } from '@/lib/server/first-touch';
import { config } from '@/lib/server/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Who hears about a new request. */
const NOTIFY = process.env.DEMO_REQUEST_NOTIFY ?? 'pete@caselightning.co.uk';

/**
 * A firm asking for a demo (migration 138), or a demo booked in the calendar (139). Saved first; then we are told by email, and the person gets a short
 * confirmation. Either email failing never loses the request. A filled-in hidden field (`website`) is a bot: it
 * is thanked and dropped.
 */
export async function POST(req: NextRequest) {
  try {
    const raw = await req.json();
    // A demo booked in the calendar (139): the calendar emails us and holds who booked; we keep the booking and where they came from.
    if (raw && typeof raw === 'object' && 'bookingEventUri' in raw) {
      const k = z.object({ bookingEventUri: z.string().url().max(300).regex(/^https:\/\/api\.calendly\.com\//), bookingInviteeUri: z.string().url().max(300).regex(/^https:\/\/api\.calendly\.com\//).optional() }).parse(raw);
      const source = firstTouchTags(await firstTouch(req.cookies.get('cl_vid')?.value));
      await runAsSystem(() => query(`insert into demo_request (booking_event_uri, booking_invitee_uri, source) values ($1, $2, $3::jsonb)`, [k.bookingEventUri, k.bookingInviteeUri ?? null, JSON.stringify(source)]));
      return ok({ ok: true });
    }
    const b = z.object({
      name: z.string().trim().min(2).max(120),
      email: z.string().trim().email().max(200),
      firm: z.string().trim().min(2).max(160),
      phone: z.string().trim().max(40).regex(/^[0-9 +()-]*$/, 'A phone number, digits only').optional().default(''),
      feeEarners: z.string().trim().max(40).optional().default(''),
      note: z.string().trim().max(2000).optional().default(''),
      website: z.string().optional().default(''),
      source: z.record(z.string(), z.string().max(200)).optional().default({}),
    }).parse(raw);
    if (b.website) return ok({ ok: true });
    // Where they first came from (the ad, the email, a search): our own buttons carry our own tags.
    b.source = { ...b.source, ...firstTouchTags(await firstTouch(req.cookies.get('cl_vid')?.value)) };
    await runAsSystem(() => query(
      `insert into demo_request (name, email, firm, phone, fee_earners, note, source) values ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [b.name, b.email.toLowerCase(), b.firm, b.phone || null, b.feeEarners || null, b.note || null, JSON.stringify(b.source)]
    ));
    if (config.resendApiKey && config.resendFromEmail) {
      const resend = new Resend(config.resendApiKey);
      const first = b.name.split(/\s+/)[0];
      const lines = [`${b.name} <${b.email}>`, b.firm, b.phone && `Phone: ${b.phone}`, b.feeEarners && `Fee earners: ${b.feeEarners}`, b.note && `\n${b.note}`, Object.keys(b.source).length ? `\nCame from: ${Object.entries(b.source).map(([k, v]) => `${k}=${v}`).join(' ')}` : ''].filter(Boolean).join('\n');
      await resend.emails.send({ from: config.resendFromEmail, to: NOTIFY, replyTo: b.email, subject: `Demo request: ${b.firm}`, text: lines }).catch((e) => console.error('demo request notify failed', e));
      await resend.emails.send({ from: config.resendFromEmail, to: b.email, replyTo: NOTIFY, subject: 'Your CONVEYi demo', text: `Hi ${first},\n\nThanks for asking for a demo of CONVEYi. I will email you within one working day to find a time that suits.\n\nPete\nCase Lightning` }).catch((e) => console.error('demo request confirmation failed', e));
    }
    return ok({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
