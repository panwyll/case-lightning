import { NextRequest, NextResponse } from 'next/server';
import { LeadScanError, startLeadScan, type LeadScanCode } from '@/lib/server/lead-scan';
import { firstTouch, firstTouchTags } from '@/lib/server/first-touch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Back from Microsoft (app/api/v1/scan/start). A firm that lets only IT approve apps sends the person back with
 * AADSTS65001 / 90094 / 90095: the page then says so, and offers the calculator and a demo instead.
 */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const back = (code: LeadScanCode) => {
    const res = NextResponse.redirect(new URL(`/conveyi/scan?error=${code}#start`, req.url));
    res.cookies.delete({ name: 'cl_scan_state', path: '/api/v1/scan' });
    return res;
  };
  const error = q.get('error');
  if (error) {
    const why = `${error} ${q.get('error_description') ?? ''}`;
    // AADSTS65004: they declined. 65001, 90094, 90095: their firm needs an admin to approve the app.
    if (/AADSTS65004/.test(why)) return back('cancelled');
    if (/AADSTS(65001|90094|90095)|admin|consent_required/i.test(why)) return back('admin');
    if (/access_denied|cancel/i.test(why)) return back('cancelled');
    console.error('lead scan sign-in refused', why.slice(0, 300));
    return back('failed');
  }
  const state = req.cookies.get('cl_scan_state')?.value;
  const code = q.get('code');
  if (!state || state !== q.get('state') || !code) return back('expired');
  try {
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null;
    const source = firstTouchTags(await firstTouch(req.cookies.get('cl_vid')?.value));
    const token = await startLeadScan({ code, ip, source });
    const res = NextResponse.redirect(new URL(`/conveyi/scan/${token}`, req.url));
    res.cookies.delete({ name: 'cl_scan_state', path: '/api/v1/scan' });
    return res;
  } catch (e) {
    if (e instanceof LeadScanError) return back(e.code);
    console.error('lead scan could not start', e);
    return back('failed');
  }
}
