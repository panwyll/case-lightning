import { NextResponse } from 'next/server';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { runAsAutomation } from '@/lib/server/db';
import { InTouchHttpClient } from '@/lib/server/integrations/intouch/client';
import { INTOUCH_WEBHOOK_EVENTS } from '@/lib/server/integrations/intouch/endpoints';
import { inTouchClientConfig, inTouchConfigured, inTouchWebhookUrl, PgInTouchTokenStore, setInTouchConnectionMeta } from '@/lib/server/integrations/intouch/adapters';
import { writeAudit } from '@/lib/server/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Connect the firm's InTouch account.
 *
 * The default grant is client-credentials, so connecting is a server-to-server call and
 * there is nowhere to send the person: we get a token, read the account name back so the
 * settings page can show WHAT was connected, and register the webhook. When the firm is
 * configured for authorization-code instead, this returns the URL to send them to.
 *
 * Admin only: this attaches the whole firm's client data to an external system.
 */
export async function POST() {
  try {
    assertFeature('auth');
    const user = await requireUser();
    if (user.role !== 'ADMIN') throw Object.assign(new Error('Only an admin connects InTouch.'), { status: 403 });
    if (!inTouchConfigured()) throw Object.assign(new Error('InTouch is not configured on this deployment.'), { status: 503 });

    const cfg = inTouchClientConfig();
    if (cfg.grant === 'authorization_code') {
      const state = crypto.randomUUID();
      const url = InTouchHttpClient.authorizeUrl(cfg, state);
      const res = NextResponse.json({ ok: true, data: { authorizeUrl: url } });
      res.cookies.set('cl_intouch_state', state, { path: '/', httpOnly: true, sameSite: 'lax', secure: true, maxAge: 600 });
      return res;
    }

    const client = new InTouchHttpClient(cfg, user.tenantId, new PgInTouchTokenStore());
    await client.connectWithClientCredentials();
    const account = await client.account();
    // Best-effort: a firm whose InTouch plan has no webhooks still works on polling.
    let webhookSubId: string | null = null;
    try {
      webhookSubId = (await runAsAutomation(() => client.subscribeWebhook(inTouchWebhookUrl(), INTOUCH_WEBHOOK_EVENTS))).id;
    } catch {
      /* polling covers it; the settings page says which is in use */
    }
    await setInTouchConnectionMeta(user.tenantId, { accountId: account.id, accountName: account.name, webhookSubId, connectedBy: user.userId });
    await writeAudit({ tenantId: user.tenantId, actorUserId: user.userId, actionType: 'INTOUCH_CONNECTED', actionStatus: 'SUCCESS', payload: { accountId: account.id, accountName: account.name, webhook: !!webhookSubId } }).catch(() => {});
    return ok({ connected: true, account, webhook: !!webhookSubId });
  } catch (error) {
    return fail(error);
  }
}
