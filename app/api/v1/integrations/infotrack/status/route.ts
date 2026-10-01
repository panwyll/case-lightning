import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { query } from '@/lib/server/db';
import { infotrackConnection, infotrackCredentials, infotrackWebhookUrl } from '@/lib/server/integrations/infotrack-adapters';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The InfoTrack page: the saved details (never a secret), the connection, and the firm's recent orders. */
export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const admin = user.role === 'ADMIN';
    const [creds, connection] = await Promise.all([infotrackCredentials(user.tenantId), infotrackConnection(user.tenantId)]);
    const firm = creds?.source === 'firm' ? creds : null;
    const orders = await query<{ id: string; matter_id: string; matter_ref: string; kind: string; subject: string | null; provider_ref: string; status: string; created_at: Date; updated_at: Date }>(
      `select o.id, o.matter_id, m.matter_ref, o.kind, o.subject, o.provider_ref, o.status, o.created_at, o.updated_at
         from integration_order o join matter m on m.id = o.matter_id
        where o.tenant_id = $1 and o.provider = 'infotrack' order by o.created_at desc limit 50`,
      [user.tenantId]
    ).catch(() => []);
    return ok({
      // The firm enters its own account: "configured" means there is something to order on.
      configured: !!creds,
      canManage: admin,
      connection: connection ?? (creds?.source === 'deployment' ? { status: 'CONNECTED', statusDetail: 'Using this deployment\'s InfoTrack account', connectedAt: null } : null),
      credentials: firm ? { baseUrl: firm.baseUrl, clientId: firm.clientId, tokenUrl: firm.tokenUrl, hasClientSecret: true, hasSigningSecret: !!firm.signingSecret } : null,
      // The result URL carries the key that authenticates deliveries: admins only.
      webhookUrl: admin && firm?.webhookKey ? infotrackWebhookUrl(user.tenantId, firm.webhookKey) : null,
      orders: orders.map((o) => ({ id: o.id, matterId: o.matter_id, matterRef: o.matter_ref, kind: o.kind, subject: o.subject, reference: o.provider_ref, status: o.status, orderedAt: o.created_at.toISOString(), updatedAt: o.updated_at.toISOString() })),
    });
  } catch (error) {
    return fail(error);
  }
}
