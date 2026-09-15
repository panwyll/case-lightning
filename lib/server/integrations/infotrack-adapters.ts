/**
 * Production wiring for the InfoTrack integration: Postgres order bookkeeping, the
 * matter lookup the providers need, filing downloaded results into the matter's
 * OneDrive folder (falling back to document_blob), and the singleton client.
 */
import crypto from 'node:crypto';
import { config } from '../config';
import { query, queryOne } from '../db';
import { uploadToMatterKb } from '../graph';
import { driveUserFor } from '../matter-drive';
import { InfoTrackClient, InfoTrackIdCheckProvider, InfoTrackSearchProvider, InfoTrackTitleProvider, type IntegrationOrder, type IntegrationOrderStore, type MatterLookup, type ResultFiler } from './infotrack';

export class PgOrderStore implements IntegrationOrderStore {
  async record(order: IntegrationOrder, request: unknown): Promise<void> {
    await query(
      `insert into integration_order (tenant_id, matter_id, provider, kind, subject, provider_ref, status, request)
       values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
       on conflict (provider, provider_ref) do update set status = excluded.status, request = excluded.request, updated_at = now()`,
      [order.tenantId, order.matterId, order.provider, order.kind, order.subject, order.providerRef, order.status, JSON.stringify(request ?? {})]
    );
  }
  async find(provider: string, providerRef: string): Promise<IntegrationOrder | null> {
    const r = await queryOne<{ tenant_id: string; matter_id: string; provider: string; kind: IntegrationOrder['kind']; subject: string | null; provider_ref: string; status: IntegrationOrder['status'] }>(
      `select tenant_id, matter_id, provider, kind, subject, provider_ref, status from integration_order where provider = $1 and provider_ref = $2`,
      [provider, providerRef]
    );
    return r ? { tenantId: r.tenant_id, matterId: r.matter_id, provider: r.provider, kind: r.kind, subject: r.subject, providerRef: r.provider_ref, status: r.status } : null;
  }
  async update(provider: string, providerRef: string, status: IntegrationOrder['status'], result?: unknown): Promise<void> {
    await query(`update integration_order set status = $3, result = coalesce($4::jsonb, result), updated_at = now() where provider = $1 and provider_ref = $2`, [provider, providerRef, status, result === undefined ? null : JSON.stringify(result)]);
  }
}

export const pgMatterLookup: MatterLookup = async (tenantId, matterId) => {
  const m = await queryOne<{ matter_ref: string; property_address: string; buyer_names: string[] }>(`select matter_ref, property_address, buyer_names from matter where id = $1 and tenant_id = $2`, [matterId, tenantId]);
  if (!m) throw new Error('Matter not found.');
  const client = await queryOne<{ email: string | null; phone: string | null }>(
    `select email, phone from matter_contact where matter_id = $1 and tenant_id = $2 and role = 'CLIENT' order by last_seen_at desc limit 1`,
    [matterId, tenantId]
  ).catch(() => null);
  const title = await queryOne<{ title_number: string | null }>(`select state->'title'->'facts'->>'titleNumber' as title_number from matter_engine_state where matter_id = $1`, [matterId]).catch(() => null);
  return { matterRef: m.matter_ref, address: m.property_address, buyerNames: m.buyer_names ?? [], clientEmail: client?.email ?? null, clientPhone: client?.phone ?? null, titleNumber: title?.title_number ?? null };
};

/** File a provider download like any other matter document: OneDrive first, document_blob as the safety net. */
export class PgResultFiler implements ResultFiler {
  async file(input: { tenantId: string; matterId: string; fileName: string; mimeType: string; bytes: Buffer; docType: string; providerRef: string }): Promise<string> {
    const m = await queryOne<{ folder_path: string | null; created_by: string }>(`select folder_path, created_by from matter where id = $1 and tenant_id = $2`, [input.matterId, input.tenantId]);
    if (!m) throw new Error('Matter not found.');
    const hash = crypto.createHash('sha256').update(input.bytes).digest('hex');
    let graphItemId: string | null = null;
    let webUrl: string | null = null;
    if (m.folder_path) {
      try {
        const owner = await driveUserFor(input.tenantId, input.matterId, m.created_by);
        const item = await uploadToMatterKb(owner, m.folder_path, input.fileName, input.bytes);
        graphItemId = item?.id ?? null;
        webUrl = item?.webUrl ?? null;
      } catch {
        /* OneDrive unavailable — keep the bytes locally below */
      }
    }
    const doc = await queryOne<{ id: string }>(
      `insert into document (tenant_id, matter_id, source_type, graph_item_id, storage_path, web_url, file_name, mime_type, size_bytes, hash_sha256, doc_type)
       values ($1,$2,'INFOTRACK',$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
      [input.tenantId, input.matterId, graphItemId, graphItemId ? `${m.folder_path}/${input.fileName}` : `infotrack://${input.providerRef}/${input.fileName}`, webUrl, input.fileName, input.mimeType, input.bytes.length, hash, input.docType]
    );
    if (!graphItemId) {
      await query(`insert into document_blob (document_id, tenant_id, bytes) values ($1,$2,$3) on conflict (document_id) do nothing`, [doc!.id, input.tenantId, input.bytes]);
    }
    return doc!.id;
  }
}

export function infotrackConfigured(): boolean {
  return !!(config.infotrackBaseUrl && config.infotrackClientId && config.infotrackClientSecret);
}

let _client: InfoTrackClient | null = null;
export function infotrackClient(): InfoTrackClient {
  if (!_client) {
    if (!infotrackConfigured()) throw new Error('InfoTrack is not configured (INFOTRACK_BASE_URL / CLIENT_ID / CLIENT_SECRET).');
    _client = new InfoTrackClient({
      baseUrl: config.infotrackBaseUrl!.replace(/\/+$/, ''),
      clientId: config.infotrackClientId!,
      clientSecret: config.infotrackClientSecret!,
      tokenUrl: config.infotrackTokenUrl,
      webhookSecret: config.infotrackWebhookSecret,
      callbackUrl: `${config.appUrl}/api/v1/integrations/infotrack/webhook`,
    });
  }
  return _client;
}

export function infotrackProviders() {
  const client = infotrackClient();
  const orders = new PgOrderStore();
  return {
    searchProvider: new InfoTrackSearchProvider(client, orders, pgMatterLookup),
    idCheckProvider: new InfoTrackIdCheckProvider(client, orders, pgMatterLookup),
    titleProvider: new InfoTrackTitleProvider(client, orders, pgMatterLookup),
    orders,
    client,
  };
}

/** Idempotency for provider retries: returns false if this delivery was already handled. */
export async function claimWebhookDelivery(provider: string, deliveryId: string): Promise<boolean> {
  const r = await query<{ id: string }>(`insert into integration_webhook (provider, delivery_id, status) values ($1,$2,'PROCESSING') on conflict (provider, delivery_id) do nothing returning id`, [provider, deliveryId]);
  return r.length > 0;
}

export async function finishWebhookDelivery(provider: string, deliveryId: string, status: 'PROCESSED' | 'IGNORED' | 'FAILED', detail: string | null): Promise<void> {
  await query(`update integration_webhook set status = $3, detail = $4 where provider = $1 and delivery_id = $2`, [provider, deliveryId, status, detail]).catch(() => {});
}
