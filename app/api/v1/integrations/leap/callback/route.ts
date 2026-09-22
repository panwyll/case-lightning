import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { assertFeature, config } from '@/lib/server/config';
import { requireRole } from '@/lib/server/session';
import { fail } from '@/lib/server/http';
import { decryptSecret } from '@/lib/server/crypto';
import { LeapHttpClient } from '@/lib/server/integrations/leap/client';
import { leapClientConfig, PgLeapTokenStore, setLeapConnectionMeta, leapApi, leapSyncDeps, syncMatters } from '@/lib/server/integrations/leap/adapters';
import { runAsAutomation } from '@/lib/server/db';
import { writeAudit } from '@/lib/server/audit';
import { paths } from '@/lib/paths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/** LEAP sends the code back here. Exchange it, record the firm, subscribe the webhook, run a first sync. */
export async function GET(req: NextRequest) {
  try {
    assertFeature('leap');
    const user = await requireRole(['ADMIN']);
    const jar = await cookies();
    const raw = jar.get('cl_leap_oauth')?.value;
    if (!raw) return fail(Object.assign(new Error('LEAP connection did not start from this browser. Try again from /integrations/leap.'), { status: 400 }));
    const st = JSON.parse(decryptSecret(raw)) as { state: string; verifier: string; tenantId: string; userId: string; at: number };
    const q = req.nextUrl.searchParams;
    if (q.get('error')) return fail(Object.assign(new Error(`LEAP refused the connection: ${q.get('error_description') ?? q.get('error')}`), { status: 400 }));
    if (q.get('state') !== st.state || st.tenantId !== user.tenantId || Date.now() - st.at > 600_000) return fail(Object.assign(new Error('LEAP connection state mismatch — start again.'), { status: 400 }));
    const code = q.get('code');
    if (!code) return fail(Object.assign(new Error('No authorization code from LEAP.'), { status: 400 }));

    const client = new LeapHttpClient(leapClientConfig(), user.tenantId, new PgLeapTokenStore());
    await client.connectWithCode(code, st.verifier);
    const firm = await client.firm().catch(() => null);
    let webhookSubId: string | null = null;
    try {
      webhookSubId = (await client.subscribeWebhook(`${config.appUrl}/api/v1/integrations/leap/webhook`, ['matter.created', 'matter.updated', 'matter.closed', 'document.created', 'document.updated', 'card.updated'])).id;
    } catch (err) {
      console.warn('[leap] webhook subscription failed; polling sync will carry the load', (err as Error).message);
    }
    await setLeapConnectionMeta(user.tenantId, { firmId: firm?.id ?? null, firmName: firm?.name ?? null, region: firm?.region ?? config.leapRegion, webhookSubId, connectedBy: user.userId });
    await writeAudit({ tenantId: user.tenantId, matterId: null, actorUserId: user.userId, actionType: 'LEAP_CONNECTED', actionStatus: 'SUCCESS', payload: { firmId: firm?.id ?? null, webhookSubId } }).catch(() => {});
    // First sync in the background of this request (bounded); the cron carries on from the watermark.
    void leapApi(user.tenantId);
    runAsAutomation(async () => syncMatters(await leapSyncDeps(user.tenantId), user.tenantId, { full: true })).catch((err) => console.warn('[leap] initial sync failed', (err as Error).message));
    const res = NextResponse.redirect(`${config.appUrl}${paths.leap}?connected=1`, 302);
    res.cookies.set('cl_leap_oauth', '', { maxAge: 0, path: '/api/v1/integrations/leap' });
    return res;
  } catch (error) {
    return fail(error);
  }
}
