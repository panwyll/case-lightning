import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { InTouchHttpClient } from '@/lib/server/integrations/intouch/client';
import { inTouchClientConfig, inTouchCredentials, inTouchWebhookUrl, markInTouchConnected, markInTouchError, saveInTouchCredentials } from '@/lib/server/integrations/intouch/adapters';
import { InTouchError } from '@/lib/server/integrations/intouch/types';
import { writeAudit } from '@/lib/server/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const blank = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);
const Body = z.object({
  apiBaseUrl: z.string().max(500).optional(),
  apiToken: z.string().max(2000).optional(),
});

/**
 * Connect the firm's InTouch account with the API key the firm generated in InTouch
 * (Settings > API > Keys). InTouch has no OAuth: the key rides every request.
 *
 * The address and key are saved (encrypted) against the firm first, so a failed attempt
 * keeps what was typed and says why; a key left blank keeps the one already saved. Then
 * the account is read back to prove the key works — only that marks the firm CONNECTED.
 * InTouch has no API to register webhooks, so the reply carries the firm's webhook URL
 * for the admin to paste into InTouch.
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
    const apiBaseUrl = blank(body.apiBaseUrl) ?? saved?.apiBaseUrl ?? null;
    const apiToken = blank(body.apiToken) ?? saved?.apiToken ?? null;
    if (!apiBaseUrl || !apiToken) throw Object.assign(new Error('Enter the InTouch API Address and API Key.'), { status: 400 });
    let url: URL;
    try {
      url = new URL(apiBaseUrl);
    } catch {
      throw Object.assign(new Error('The InTouch API Address is not a web address.'), { status: 400 });
    }
    if (url.protocol !== 'https:') throw Object.assign(new Error('The InTouch API Address must start with https://.'), { status: 400 });

    const creds = await saveInTouchCredentials(user.tenantId, { apiBaseUrl, apiToken });
    const client = new InTouchHttpClient({ ...inTouchClientConfig(creds), maxRetries: 1 }, user.tenantId);
    const account = await client.account();
    await markInTouchConnected(user.tenantId, { accountId: account.id || null, accountName: account.name, connectedBy: user.userId });
    await writeAudit({ tenantId: user.tenantId, actorUserId: user.userId, actionType: 'INTOUCH_CONNECTED', actionStatus: 'SUCCESS', payload: { accountId: account.id, accountName: account.name } }).catch(() => {});
    return ok({ connected: true, account, webhookUrl: inTouchWebhookUrl(user.tenantId, creds.webhookKey) });
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
  if (error instanceof TypeError) return 'Could not reach InTouch at that address. Check the API Address.';
  const status = (error as InTouchError).status;
  if (status === 401 || status === 403) return 'InTouch did not accept this API key. Generate one in InTouch under Settings > API.';
  if (status === 0) return 'Could not reach InTouch at that address. Check the API Address.';
  if (status === 404) return 'InTouch did not recognise that address. Check the API Address.';
  return `InTouch could not be connected (${status}). Try again shortly.`;
}
