import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { InfoTrackError } from '@/lib/server/integrations/infotrack';
import { infotrackClientFrom, infotrackCredentials, infotrackWebhookUrl, markInfoTrack, saveInfoTrackCredentials } from '@/lib/server/integrations/infotrack-adapters';
import { writeAudit } from '@/lib/server/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const blank = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);
const Body = z.object({
  baseUrl: z.string().max(500).optional(),
  clientId: z.string().max(500).optional(),
  clientSecret: z.string().max(2000).optional(),
  tokenUrl: z.string().max(500).optional(),
  signingSecret: z.string().max(2000).optional(),
});

function https(v: string, what: string): string {
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    throw Object.assign(new Error(`The ${what} is not a web address.`), { status: 400 });
  }
  if (url.protocol !== 'https:') throw Object.assign(new Error(`The ${what} must start with https://.`), { status: 400 });
  return v;
}

/**
 * Connect the firm's own InfoTrack account: orders go on its account and its bill, and show in
 * its InfoTrack (and its LEAP or InTouch, where InfoTrack is linked to them).
 *
 * What was typed is saved (encrypted) first, so a failed attempt keeps it and says why; a secret
 * left blank keeps the saved one. Then a token is requested to prove the credentials work: only
 * that marks the firm CONNECTED. The reply carries the firm's result URL; it is also sent with
 * every order, so nothing needs setting in InfoTrack.
 *
 * Admin only: this orders and pays for searches in the firm's name.
 */
export async function POST(req: NextRequest) {
  let tenantId: string | null = null;
  try {
    assertFeature('auth');
    const user = await requireUser();
    tenantId = user.tenantId;
    if (user.role !== 'ADMIN') throw Object.assign(new Error('Only an admin connects InfoTrack.'), { status: 403 });
    const body = Body.parse(await req.json().catch(() => ({})));
    const saved = await infotrackCredentials(user.tenantId);
    const mine = saved?.source === 'firm' ? saved : null;
    const baseUrl = blank(body.baseUrl) ?? mine?.baseUrl ?? null;
    const clientId = blank(body.clientId) ?? mine?.clientId ?? null;
    const clientSecret = blank(body.clientSecret) ?? mine?.clientSecret ?? null;
    if (!baseUrl || !clientId || !clientSecret) throw Object.assign(new Error('Enter the InfoTrack API Address, Client ID and Client Secret.'), { status: 400 });
    const tokenUrl = body.tokenUrl !== undefined ? blank(body.tokenUrl) : mine?.tokenUrl ?? null;
    https(baseUrl, 'API Address');
    if (tokenUrl) https(tokenUrl, 'Token Address');
    const signingSecret = blank(body.signingSecret) ?? mine?.signingSecret ?? null;

    const creds = await saveInfoTrackCredentials(user.tenantId, { baseUrl, clientId, clientSecret, tokenUrl, signingSecret });
    await infotrackClientFrom(creds, user.tenantId, { maxRetries: 1 }).accessToken();
    await markInfoTrack(user.tenantId, 'CONNECTED', null, user.userId);
    await writeAudit({ tenantId: user.tenantId, actorUserId: user.userId, actionType: 'INFOTRACK_CONNECTED', actionStatus: 'SUCCESS', payload: { baseUrl } }).catch(() => {});
    return ok({ connected: true, webhookUrl: infotrackWebhookUrl(user.tenantId, creds.webhookKey) });
  } catch (error) {
    // InfoTrack's refusal is not ours: its 401 passed through would read as the admin's session expiring.
    if (tenantId && (error instanceof InfoTrackError || error instanceof TypeError)) {
      const why = refusal(error);
      await markInfoTrack(tenantId, 'ERROR', why).catch(() => {});
      return fail(Object.assign(new Error(why), { status: 502 }));
    }
    return fail(error);
  }
}

function refusal(error: Error): string {
  if (error instanceof TypeError) return 'Could not reach InfoTrack at that address. Check the API Address.';
  const status = (error as InfoTrackError).status;
  if (status === 400 || status === 401 || status === 403) return 'InfoTrack did not accept this Client ID and Secret. Check them with InfoTrack.';
  if (status === 0) return 'Could not reach InfoTrack at that address. Check the API Address.';
  if (status === 404) return 'InfoTrack did not recognise that address. Check the API Address (or the Token Address).';
  return `InfoTrack could not be connected (${status}). Try again shortly.`;
}
