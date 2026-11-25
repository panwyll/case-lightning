import crypto from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { leadScanConfigured, signInUrl } from '@/lib/server/lead-scan';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The free scan's button (app/conveyi/scan): off to Microsoft to sign in, read-only (lib/server/lead-scan.ts). */
export async function GET(req: NextRequest) {
  if (!leadScanConfigured()) return NextResponse.redirect(new URL('/conveyi/scan?error=failed', req.url));
  const state = crypto.randomBytes(24).toString('base64url');
  const res = NextResponse.redirect(signInUrl(state));
  res.cookies.set('cl_scan_state', state, { httpOnly: true, secure: true, sameSite: 'lax', path: '/api/v1/scan', maxAge: 900 });
  return res;
}
