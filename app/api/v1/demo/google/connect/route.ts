import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import { DEMO_HOST } from '@/lib/server/demo/bookings';
import { connectUrl, googleConfigured } from '@/lib/server/demo/google';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Connect the demo host's Google Calendar (lib/server/demo/google.ts): off to Google to sign in. Only the host's own account is accepted on the way back. */
export async function GET() {
  if (!googleConfigured()) return new NextResponse('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set.', { status: 503 });
  const state = crypto.randomBytes(24).toString('base64url');
  const res = NextResponse.redirect(connectUrl(state, DEMO_HOST.email));
  res.cookies.set('demo_google_state', state, { httpOnly: true, secure: true, sameSite: 'lax', path: '/api/v1/demo/google', maxAge: 600 });
  return res;
}
