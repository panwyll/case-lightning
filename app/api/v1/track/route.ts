import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { config } from '@/lib/server/config';
import { query } from '@/lib/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VID_COOKIE = 'cl_vid';
const BOT_RE = /bot|crawler|spider|crawling|facebookexternalhit|slurp|bingpreview|headless|lighthouse/i;

/**
 * First-party pageview beacon — the top of the acquisition funnel. Public and
 * best-effort: it never errors the caller (a tracking failure must not break the
 * site). The anonymous visitor id lives in the cl_vid cookie (set here if absent);
 * obvious bots and non-marketing paths are dropped so the funnel stays clean.
 */
export async function POST(req: NextRequest) {
  // Always 204 — set the visitor cookie if this is a new visitor.
  const existing = req.cookies.get(VID_COOKIE)?.value;
  const visitorId = existing && /^[A-Za-z0-9_-]{8,64}$/.test(existing) ? existing : crypto.randomUUID();
  const res = new NextResponse(null, { status: 204 });
  if (!existing) {
    res.cookies.set(VID_COOKIE, visitorId, {
      path: '/',
      maxAge: 60 * 60 * 24 * 365,
      sameSite: 'lax',
      httpOnly: false,
    });
  }

  try {
    if (!config.databaseUrl) return res;
    const ua = req.headers.get('user-agent') ?? '';
    if (BOT_RE.test(ua)) return res;

    const body = z
      .object({
        path: z.string().max(512),
        referrer: z.string().max(1024).optional(),
        utm_source: z.string().max(128).optional(),
        utm_medium: z.string().max(128).optional(),
        utm_campaign: z.string().max(128).optional(),
      })
      .parse(await req.json());

    await query(
      `insert into pageview_event (visitor_id, path, referrer, utm_source, utm_medium, utm_campaign, user_agent)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [
        visitorId,
        body.path,
        body.referrer ?? null,
        body.utm_source ?? null,
        body.utm_medium ?? null,
        body.utm_campaign ?? null,
        ua.slice(0, 512),
      ]
    );
  } catch {
    /* best-effort: swallow everything, still return 204 */
  }
  return res;
}
