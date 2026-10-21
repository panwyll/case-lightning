import { NextRequest } from 'next/server';
import { z } from 'zod';
import { Resend } from 'resend';
import { ok, fail } from '@/lib/server/http';
import { query, queryOne, runAsSystem } from '@/lib/server/db';
import { config } from '@/lib/server/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Who hears about a new request. */
const NOTIFY = process.env.DEMO_REQUEST_NOTIFY ?? 'pete@caselightning.co.uk';

/**
 * A firm asking for a demo (migration 138). Saved first; then we are told by email, and the person gets a short
 * confirmation. Either email failing never loses the request. A filled-in hidden field (`website`) is a bot: it
 * is thanked and dropped.
 */
export async function POST(req: NextRequest) {
  try {
    const b = z.object({
      name: z.string().trim().min(2).max(120),
      email: z.string().trim().email().max(200),
      firm: z.string().trim().min(2).max(160),
      phone: z.string().trim().max(40).regex(/^[0-9 +()-]*$/, 'A phone number, digits only').optional().default(''),
      feeEarners: z.string().trim().max(40).optional().default(''),
      note: z.string().trim().max(2000).optional().default(''),
      website: z.string().optional().default(''),
      source: z.record(z.string(), z.string().max(200)).optional().default({}),
    }).parse(await req.json());
    if (b.website) return ok({ ok: true });
    // Where they first came from (the ad, the email, a search), from this visitor's first tagged page view: the
    // buttons on our own pages carry our own tags, so the ad's are only on the address they landed on.
    const visitor = req.cookies.get('cl_vid')?.value ?? null;
    const first = visitor ? await runAsSystem(() => queryOne<{ path: string; referrer: string | null; utm_source: string | null; utm_medium: string | null; utm_campaign: string | null }>(
      `select path, referrer, utm_source, utm_medium, utm_campaign from pageview_event
        where visitor_id = $1 and coalesce(utm_medium, '') <> 'cta' order by created_at asc limit 1`,
      [visitor]
    )).catch(() => null) : null;
    if (first) b.source = { ...b.source, first_path: first.path, ...(first.referrer ? { first_referrer: first.referrer.slice(0, 200) } : {}), ...(first.utm_source ? { first_utm_source: first.utm_source } : {}), ...(first.utm_medium ? { first_utm_medium: first.utm_medium } : {}), ...(first.utm_campaign ? { first_utm_campaign: first.utm_campaign } : {}) };
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
