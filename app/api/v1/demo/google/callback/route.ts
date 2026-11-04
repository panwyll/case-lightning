import { NextRequest, NextResponse } from 'next/server';
import { DEMO_HOST } from '@/lib/server/demo/bookings';
import { finishConnect } from '@/lib/server/demo/google';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const page = (title: string, line: string, status = 200) => new NextResponse(
  `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem;line-height:1.5"><h1 style="font-size:1.5rem">${title}</h1><p>${line}</p><p><a href="/conveyi/demo">Open the booking page</a></p></body>`,
  { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Back from Google (app/api/v1/demo/google/connect): check it is our sign-in, then keep the calendar's access. */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const state = req.cookies.get('demo_google_state')?.value;
  if (q.get('error')) return page('Not Connected', `Google said: ${esc(q.get('error')!)}.`, 400);
  if (!state || state !== q.get('state') || !q.get('code')) return page('Not Connected', 'This sign-in has expired. Start again.', 400);
  try {
    const account = await finishConnect(q.get('code')!, DEMO_HOST.email);
    const res = page('Calendar Connected', `The booking page now reads busy times from ${esc(account)}. Only free and busy, never what your events are.`);
    res.cookies.delete({ name: 'demo_google_state', path: '/api/v1/demo/google' });
    return res;
  } catch (e) {
    console.error('demo Google connect failed', e);
    return page('Not Connected', esc(e instanceof Error ? e.message : 'Something went wrong.'), 400);
  }
}
