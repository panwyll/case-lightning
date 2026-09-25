import { NextRequest } from 'next/server';
import { assertFeature, config } from '@/lib/server/config';
import { ok, fail } from '@/lib/server/http';
import { queryOne, runAsAutomation, runAsSystem } from '@/lib/server/db';
import { verifyWebhookSignature } from '@/lib/server/integrations/intouch/client';
import { INTOUCH_WEBHOOK_SIGNATURE_HEADER, INTOUCH_WEBHOOK_DELIVERY_HEADER } from '@/lib/server/integrations/intouch/endpoints';
import { toWebhookEvent } from '@/lib/server/integrations/intouch/mapping';
import { applyWebhook } from '@/lib/server/integrations/intouch/sync';
import { inTouchCredentials, inTouchSyncDeps } from '@/lib/server/integrations/intouch/adapters';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * InTouch → CONVEYi.
 *
 * The body is a POINTER (event type + ids), never trusted for content: the handler
 * re-reads the resource from InTouch. Signed with the firm's webhook secret; an unsigned
 * delivery is refused when a secret is configured, because an unauthenticated webhook is
 * an open door into a client's file. Runs as automation, so nothing arriving this way can
 * write a payment or a send event whatever it claims to be.
 */
export async function POST(req: NextRequest) {
  try {
    assertFeature('db');
    const raw = await req.text();
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
    const event = toWebhookEvent(JSON.parse(raw), headers);

    // Which firm is this for? InTouch delivers per connection, and a case id is only ever
    // mirrored under one tenant, so the mirror row is the lookup.
    const tenantId = await tenantForCase(event.caseId);
    if (!tenantId) return ok({ received: true, outcome: { status: 'IGNORED', reason: 'no connected firm holds this case' } });
    // Nothing is acted on until the delivery is proven to be from that firm's InTouch.
    const creds = await inTouchCredentials(tenantId);
    if (!creds) return fail(Object.assign(new Error('InTouch is not connected for this firm.'), { status: 503 }));
    if (!verifyWebhookSignature(raw, req.headers.get(INTOUCH_WEBHOOK_SIGNATURE_HEADER), creds.webhookSecret ?? config.intouchWebhookSecret ?? null)) {
      return fail(Object.assign(new Error('Invalid webhook signature.'), { status: 401 }));
    }

    const deps = await inTouchSyncDeps(tenantId);
    const summary = await runAsAutomation(() => applyWebhook(deps, tenantId, event));
    return ok({ received: true, summary });
  } catch (error) {
    return fail(error);
  }
}

/**
 * A case we already mirror tells us the firm directly. A case we do not yet know can only
 * belong to a connected firm — and where exactly one firm is connected that is
 * unambiguous. With several, the event is ignored and the next poll picks the case up,
 * because guessing which firm a client's data belongs to is not a risk worth taking.
 */
async function tenantForCase(caseId: string | null): Promise<string | null> {
  return runAsSystem(async () => {
    if (caseId) {
      const m = await queryOne<{ tenant_id: string }>(`select tenant_id from matter where intouch_case_id = $1 limit 1`, [caseId]).catch(() => null);
      if (m) return m.tenant_id;
    }
    const only = await queryOne<{ tenant_id: string; n: string }>(
      `select tenant_id, (select count(*) from intouch_connection where status = 'CONNECTED')::text as n
         from intouch_connection where status = 'CONNECTED' limit 1`
    ).catch(() => null);
    return only && Number(only.n) === 1 ? only.tenant_id : null;
  });
}
