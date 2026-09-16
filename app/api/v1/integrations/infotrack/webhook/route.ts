import { NextRequest } from 'next/server';
import { assertFeature, config } from '@/lib/server/config';
import { ok, fail } from '@/lib/server/http';
import { engine } from '@/lib/server/engine/adapters';
import { runAsAutomation } from '@/lib/server/db';
import { InfoTrackClient } from '@/lib/server/integrations/infotrack';
import { handleInfoTrackResult } from '@/lib/server/integrations/infotrack';
import { PgOrderStore, PgResultFiler, claimWebhookDelivery, finishWebhookDelivery, infotrackClient, infotrackConfigured } from '@/lib/server/integrations/infotrack-adapters';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * Component #4: InfoTrack results webhook. The raw body is HMAC-verified with
 * INFOTRACK_WEBHOOK_SECRET; the only fields trusted from it are the order reference
 * and the document URL — tenant, matter and sub-flow come from our own order record.
 * Deliveries are idempotent (providers retry). A result is downloaded, filed as a
 * document on the matter (OneDrive, or document_blob as a safety net) and handed to
 * the engine, which extracts, rule-checks and clears or flags it.
 */
export async function POST(req: NextRequest) {
  try {
    assertFeature('db');
    const secret = config.infotrackWebhookSecret;
    if (!secret || !infotrackConfigured()) return fail(Object.assign(new Error('InfoTrack webhook is not configured.'), { status: 503 }));
    const raw = await req.text();
    if (!InfoTrackClient.verifySignature(secret, raw, req.headers.get('x-infotrack-signature'))) {
      return fail(Object.assign(new Error('Invalid webhook signature.'), { status: 401 }));
    }
    const event = InfoTrackClient.parseWebhook(raw);
    if (!(await claimWebhookDelivery('infotrack', event.deliveryId))) return ok({ received: true, duplicate: true });

    const svc = engine();
    let outcome;
    try {
      outcome = await runAsAutomation(() => handleInfoTrackResult(
        { client: infotrackClient(), orders: new PgOrderStore(), filer: new PgResultFiler(), router: svc },
        event
      ));
    } catch (err) {
      await finishWebhookDelivery('infotrack', event.deliveryId, 'FAILED', (err as Error).message);
      throw err;
    }
    await finishWebhookDelivery('infotrack', event.deliveryId, outcome.status, 'reason' in outcome ? outcome.reason : outcome.documentId);
    return ok({ received: true, outcome });
  } catch (error) {
    return fail(error);
  }
}
