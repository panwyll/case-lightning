import { NextRequest, NextResponse } from 'next/server';
import { assertFeature, config } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { fail } from '@/lib/server/http';
import { runAsAutomation } from '@/lib/server/db';
import { InTouchHttpClient } from '@/lib/server/integrations/intouch/client';
import { INTOUCH_WEBHOOK_EVENTS } from '@/lib/server/integrations/intouch/endpoints';
import { inTouchClientConfig, inTouchWebhookUrl, PgInTouchTokenStore, setInTouchConnectionMeta } from '@/lib/server/integrations/intouch/adapters';
import { paths } from '@/lib/paths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The authorization-code return leg, used only where InTouch requires a person to consent. */
export async function GET(req: NextRequest) {
  const settings = `${config.appUrl}${paths.leap.replace('/leap', '/intouch')}`;
  try {
    assertFeature('auth');
    const user = await requireUser();
    const code = req.nextUrl.searchParams.get('code');
    const state = req.nextUrl.searchParams.get('state');
    const expected = req.cookies.get('cl_intouch_state')?.value;
    if (!code) throw new Error('InTouch did not return an authorization code.');
    if (!state || !expected || state !== expected) throw new Error('The InTouch sign-in state did not match. Start again.');

    const client = new InTouchHttpClient(inTouchClientConfig(), user.tenantId, new PgInTouchTokenStore());
    await client.connectWithCode(code);
    const account = await client.account();
    let webhookSubId: string | null = null;
    try {
      webhookSubId = (await runAsAutomation(() => client.subscribeWebhook(inTouchWebhookUrl(), INTOUCH_WEBHOOK_EVENTS))).id;
    } catch {
      /* polling covers it */
    }
    await setInTouchConnectionMeta(user.tenantId, { accountId: account.id, accountName: account.name, webhookSubId, connectedBy: user.userId });
    const res = NextResponse.redirect(`${settings}?connected=1`);
    res.cookies.delete('cl_intouch_state');
    return res;
  } catch (error) {
    const why = error instanceof Error ? error.message : 'InTouch could not be connected.';
    return NextResponse.redirect(`${settings}?error=${encodeURIComponent(why)}`);
  }
}
