import { NextRequest } from 'next/server';
import { assertFeature, config } from '@/lib/server/config';
import { ok, fail } from '@/lib/server/http';
import { runAsAutomation } from '@/lib/server/db';
import { LeapHttpClient } from '@/lib/server/integrations/leap/client';
import { LEAP_WEBHOOK_DELIVERY_HEADER, LEAP_WEBHOOK_SIGNATURE_HEADER } from '@/lib/server/integrations/leap/endpoints';
import { claimLeapDelivery, finishLeapDelivery, handleLeapWebhook, leapBackendActive, leapSyncDeps, parseLeapWebhook, tenantForLeapFirm } from '@/lib/server/integrations/leap/adapters';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * LEAP → CONVEYi. The body is a pointer (event type + ids), never trusted for content:
 * the handler re-reads the resource from LEAP. Signed with LEAP_WEBHOOK_SECRET when set;
 * idempotent on the delivery id. Runs as automation (it may enrol, mirror and ingest —
 * never write a human-gated event).
 */
export async function POST(req: NextRequest) {
  try {
    assertFeature('db');
    if (!leapBackendActive()) return fail(Object.assign(new Error('LEAP is not configured.'), { status: 503 }));
    const raw = await req.text();
    if (config.leapWebhookSecret && !LeapHttpClient.verifySignature(config.leapWebhookSecret, raw, req.headers.get(LEAP_WEBHOOK_SIGNATURE_HEADER))) {
      return fail(Object.assign(new Error('Invalid webhook signature.'), { status: 401 }));
    }
    const event = parseLeapWebhook(raw, req.headers.get(LEAP_WEBHOOK_DELIVERY_HEADER));
    const tenantId = await tenantForLeapFirm(event.firmId);
    if (!tenantId) return ok({ received: true, outcome: { status: 'IGNORED', reason: 'no connected firm for this event' } });
    if (!(await claimLeapDelivery(event.id))) return ok({ received: true, duplicate: true });
    let outcome;
    try {
      outcome = await runAsAutomation(async () => handleLeapWebhook(await leapSyncDeps(tenantId), tenantId, event));
    } catch (err) {
      await finishLeapDelivery(event.id, 'FAILED', (err as Error).message);
      throw err;
    }
    await finishLeapDelivery(event.id, outcome.status, outcome.reason);
    return ok({ received: true, outcome });
  } catch (error) {
    return fail(error);
  }
}
