import { NextRequest } from 'next/server';
import { ok, fail } from '@/lib/server/http';
import { advanceLeadScan, LeadScanError, leadScanView, notifyLeadScan } from '@/lib/server/lead-scan';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type Ctx = { params: Promise<{ token: string }> };

/** Where a free scan is (app/conveyi/scan/[token]). */
export async function GET(_req: NextRequest, { params }: Ctx) {
  try {
    const v = await leadScanView((await params).token);
    return v ? ok(v, { headers: { 'cache-control': 'no-store' } }) : ok({ error: 'This scan link is not one of ours.' }, { status: 404 });
  } catch (error) {
    return fail(error);
  }
}

/** Run the scan on by one slice; once it is done, the emails go (once). */
export async function POST(_req: NextRequest, { params }: Ctx) {
  try {
    const { token } = await params;
    const v = await advanceLeadScan(token);
    if (v.status === 'COMPLETE') await notifyLeadScan(token).catch((e) => console.error('lead scan notify failed', e));
    return ok(v, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    if (error instanceof LeadScanError) return ok({ error: error.message, code: error.code }, { status: error.status });
    return fail(error);
  }
}
