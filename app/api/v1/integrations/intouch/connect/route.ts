import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { assertFeature, config } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { runAsAutomation } from '@/lib/server/db';
import { InTouchHttpClient } from '@/lib/server/integrations/intouch/client';
import { INTOUCH_WEBHOOK_EVENTS } from '@/lib/server/integrations/intouch/endpoints';
import { inTouchClientConfig, inTouchCredentials, inTouchWebhookUrl, markInTouchError, PgInTouchTokenStore, saveInTouchCredentials, setInTouchConnectionMeta } from '@/lib/server/integrations/intouch/adapters';
import { InTouchError } from '@/lib/server/integrations/intouch/types';
import { writeAudit } from '@/lib/server/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const blank = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);
const Body = z.object({
  apiBaseUrl: z.string().url().optional(),
  authBaseUrl: z.string().url().or(z.literal('')).optional(),
  clientId: z.string().max(500).optional(),
  clientSecret: z.string().max(2000).optional(),
  apiKey: z.string().max(2000).optional(),
  webhookSecret: z.string().max(2000).optional(),
});

/**
 * Connect the firm's InTouch account with the firm's own credentials.
 *
 * The admin enters the InTouch API address and the client id/secret InTouch issued the
 * firm; they are saved (encrypted) against the firm first, so a failed attempt keeps what
 * was typed and says why. A secret left blank keeps the one already saved. The default
 * grant is client-credentials: a server-to-server call, then the account name is read
 * back so the page shows WHAT was connected, and the webhook registered. When the
 * deployment is set up for authorization-code instead, this returns the URL to send the
 * admin to.
 *
 * Admin only: this attaches the whole firm's client data to an external system.
 */
export async function POST(req: NextRequest) {
  let tenantId: string | null = null;
  try {
    assertFeature('auth');
    const user = await requireUser();
    tenantId = user.tenantId;
    if (user.role !== 'ADMIN') throw Object.assign(new Error('Only an admin connects InTouch.'), { status: 403 });
    const body = Body.parse(await req.json().catch(() => ({})));

    const saved = await inTouchCredentials(user.tenantId);
    const creds = {
      apiBaseUrl: blank(body.apiBaseUrl) ?? saved?.apiBaseUrl ?? null,
      authBaseUrl: body.authBaseUrl !== undefined ? blank(body.authBaseUrl) : saved?.authBaseUrl ?? null,
      clientId: blank(body.clientId) ?? saved?.clientId ?? null,
      clientSecret: blank(body.clientSecret) ?? saved?.clientSecret ?? null,
      apiKey: blank(body.apiKey) ?? saved?.apiKey ?? null,
      webhookSecret: blank(body.webhookSecret) ?? saved?.webhookSecret ?? null,
    };
    if (!creds.apiBaseUrl || !creds.clientId || !creds.clientSecret) {
      throw Object.assign(new Error('Enter the InTouch API address, client ID and client secret.'), { status: 400 });
    }
    const full = { ...creds, apiBaseUrl: creds.apiBaseUrl, clientId: creds.clientId, clientSecret: creds.clientSecret };
    await saveInTouchCredentials(user.tenantId, full);

    const cfg = inTouchClientConfig(full);
    if (config.intouchGrant === 'authorization_code') {
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
    // InTouch's own refusal is not ours: a 401 from InTouch passed through would read as
    // the admin's session expiring. Keep what was typed; say on the page why it failed.
    if (tenantId && (error instanceof InTouchError || error instanceof TypeError)) {
      const why = inTouchRefusal(error);
      await markInTouchError(tenantId, why).catch(() => {});
      return fail(Object.assign(new Error(why), { status: 502 }));
    }
    return fail(error);
  }
}

/** What went wrong, in the admin's terms. */
function inTouchRefusal(error: Error): string {
  if (error instanceof TypeError) return 'Could not reach InTouch at that address. Check the API address.';
  const status = (error as InTouchError).status;
  if (status === 400 || status === 401 || status === 403) return 'InTouch did not accept these details. Check the client ID and secret (and API key, if you were issued one).';
  if (status === 404) return 'InTouch did not recognise that address. Check the API address.';
  return `InTouch could not be connected (${status || 'no response'}). Try again shortly.`;
}
