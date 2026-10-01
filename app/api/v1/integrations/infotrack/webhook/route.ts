import crypto from 'node:crypto';
import { NextRequest } from 'next/server';
import { assertFeature, config } from '@/lib/server/config';
import { ok, fail } from '@/lib/server/http';
import { engine } from '@/lib/server/engine/adapters';
import { runAsAutomation } from '@/lib/server/db';
import { InfoTrackClient, handleInfoTrackResult } from '@/lib/server/integrations/infotrack';
import { PgOrderStore, PgResultFiler, claimWebhookDelivery, finishWebhookDelivery, infotrackClient, infotrackClientFor, infotrackConfigured, infotrackCredentials } from '@/lib/server/integrations/infotrack-adapters';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Component #4: InfoTrack results.
 *
 * A firm's own account posts to its own URL (`?firm=…&key=…`, passed on every order): the key we
 * generated for the firm must match, compared in constant time, and when InfoTrack gave the firm
 * a signing secret the body's HMAC must match it too. The old firm-less URL is the deployment's
 * account, verified with INFOTRACK_WEBHOOK_SECRET.
 *
 * Either way the only fields trusted from the body are the order reference and the document URL;
 * tenant, matter and sub-flow come from our own order record, and a firm's URL only answers that
 * firm's orders. Deliveries are idempotent (providers retry). A result is downloaded, filed on the
 * matter and handed to the engine, which reads it and clears or flags it.
 */
export async function POST(req: NextRequest) {
  try {
    assertFeature('db');
    const firm = req.nextUrl.searchParams.get('firm');
    const raw = await req.text();
    let client: InfoTrackClient;
    if (firm) {
      const key = req.nextUrl.searchParams.get('key') ?? '';
      if (!UUID.test(firm) || !key) return unauthorised();
      const creds = await infotrackCredentials(firm);
      if (!creds?.webhookKey || !sameKey(key, creds.webhookKey)) return unauthorised();
      if (creds.signingSecret && !InfoTrackClient.verifySignature(creds.signingSecret, raw, req.headers.get('x-infotrack-signature'))) return unauthorised();
      const c = await infotrackClientFor(firm);
      if (!c) return ok({ received: true, outcome: { status: 'IGNORED', reason: 'InfoTrack is not connected for this firm' } });
      client = c;
    } else {
      const secret = config.infotrackWebhookSecret;
      if (!secret || !infotrackConfigured()) return fail(Object.assign(new Error('InfoTrack webhook is not configured.'), { status: 503 }));
      if (!InfoTrackClient.verifySignature(secret, raw, req.headers.get('x-infotrack-signature'))) return unauthorised();
      client = infotrackClient();
    }
    const event = InfoTrackClient.parseWebhook(raw);
    // The delivery id is scoped to the firm: two firms' accounts may number their events alike.
    const deliveryId = firm ? `${firm}:${event.deliveryId}` : event.deliveryId;
    if (!(await claimWebhookDelivery('infotrack', deliveryId))) return ok({ received: true, duplicate: true });

    const svc = engine();
    let outcome;
    try {
      outcome = await runAsAutomation(() => handleInfoTrackResult({ client, orders: new PgOrderStore(), filer: new PgResultFiler(), router: svc, tenantId: firm ?? undefined }, event));
    } catch (err) {
      await finishWebhookDelivery('infotrack', deliveryId, 'FAILED', (err as Error).message);
      throw err;
    }
    await finishWebhookDelivery('infotrack', deliveryId, outcome.status, 'reason' in outcome ? outcome.reason : outcome.documentId);
    return ok({ received: true, outcome });
  } catch (error) {
    return fail(error);
  }
}

function unauthorised() {
  return fail(Object.assign(new Error('Invalid webhook credentials.'), { status: 401 }));
}

function sameKey(given: string, expected: string): boolean {
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}
