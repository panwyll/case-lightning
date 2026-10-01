/**
 * Production wiring for the InfoTrack integration: Postgres order bookkeeping, the
 * matter lookup the providers need, filing downloaded results into the matter's
 * OneDrive folder (falling back to document_blob), and the singleton client.
 */
import crypto from 'node:crypto';
import { putBlob } from '../blob-store';
import { config } from '../config';
import { query, queryOne, runAsSystem } from '../db';
import { encryptSecret, decryptSecret } from '../crypto';
import { uploadToMatterKb } from '../graph';
import { driveUserFor } from '../matter-drive';
import { FirmInfoTrackRouter, InfoTrackClient, type InfoTrackStandIn, type IntegrationOrder, type IntegrationOrderStore, type MatterLookup, type ResultFiler } from './infotrack';

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
      await putBlob(input.tenantId, doc!.id, input.bytes);
    }
    return doc!.id;
  }
}

/**
 * A firm's own InfoTrack account: the API address and client credentials InfoTrack issued it,
 * the secret InfoTrack signs results with (when it gives one), and the key WE generate for the
 * firm's result URL, so a delivery is known to be that firm's before anything is read.
 * Entered by the admin on the InfoTrack page, stored encrypted (infotrack_connection);
 * INFOTRACK_* env vars are only a fallback for a deployment that serves one firm.
 */
export interface InfoTrackFirmCredentials {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  tokenUrl: string | null;
  signingSecret: string | null;
  webhookKey: string;
}

export type InfoTrackSavedCredentials = Omit<InfoTrackFirmCredentials, 'webhookKey'> & { webhookKey: string | null; source: 'firm' | 'deployment' };

export interface InfoTrackConnectionRow {
  status: 'CONNECTED' | 'DISCONNECTED' | 'ERROR';
  statusDetail: string | null;
  connectedAt: string | null;
}

function envCredentials(): Omit<InfoTrackSavedCredentials, 'source' | 'webhookKey'> | null {
  if (!(config.infotrackBaseUrl && config.infotrackClientId && config.infotrackClientSecret)) return null;
  return { baseUrl: config.infotrackBaseUrl, clientId: config.infotrackClientId, clientSecret: config.infotrackClientSecret, tokenUrl: config.infotrackTokenUrl ?? null, signingSecret: config.infotrackWebhookSecret ?? null };
}

/** The deployment-wide account (single-firm deployments, and results ordered before firms had their own). */
export function infotrackConfigured(): boolean {
  return !!envCredentials();
}

type Row = { credentials_enc: string | null; status: InfoTrackConnectionRow['status']; status_detail: string | null; connected_at: Date | null };
async function row(tenantId: string): Promise<Row | null> {
  // Before migration 120 the table does not exist: every firm reads as not connected.
  return runAsSystem(() => queryOne<Row>(`select credentials_enc, status, status_detail, connected_at from infotrack_connection where tenant_id = $1`, [tenantId])).catch(() => null);
}
function decrypt(r: Row | null): Partial<InfoTrackFirmCredentials> | null {
  if (!r?.credentials_enc) return null;
  try {
    return JSON.parse(decryptSecret(r.credentials_enc)) as Partial<InfoTrackFirmCredentials>;
  } catch {
    return null;
  }
}

/** What the firm has saved, else the deployment's; null when neither. Never shown to anyone in full. */
export async function infotrackCredentials(tenantId: string): Promise<InfoTrackSavedCredentials | null> {
  const r = await row(tenantId);
  const c = decrypt(r);
  if (c?.baseUrl && c.clientId && c.clientSecret) return { baseUrl: c.baseUrl, clientId: c.clientId, clientSecret: c.clientSecret, tokenUrl: c.tokenUrl ?? null, signingSecret: c.signingSecret ?? null, webhookKey: c.webhookKey ?? null, source: 'firm' };
  const env = envCredentials();
  return env ? { ...env, webhookKey: c?.webhookKey ?? null, source: 'deployment' } : null;
}

export async function infotrackConnection(tenantId: string): Promise<InfoTrackConnectionRow | null> {
  const r = await row(tenantId);
  return r ? { status: r.status, statusDetail: r.status_detail, connectedAt: r.connected_at?.toISOString() ?? null } : null;
}

/** Save what the admin typed; the result URL's key is generated once and then kept. */
export async function saveInfoTrackCredentials(tenantId: string, creds: Omit<InfoTrackFirmCredentials, 'webhookKey'>): Promise<InfoTrackFirmCredentials> {
  const webhookKey = decrypt(await row(tenantId))?.webhookKey ?? crypto.randomBytes(32).toString('hex');
  const full: InfoTrackFirmCredentials = { ...creds, webhookKey };
  await runAsSystem(() =>
    query(
      `insert into infotrack_connection (tenant_id, credentials_enc, updated_at) values ($1,$2,now())
       on conflict (tenant_id) do update set credentials_enc = excluded.credentials_enc, updated_at = now()`,
      [tenantId, encryptSecret(JSON.stringify(full))]
    )
  );
  _clients.delete(tenantId);
  return full;
}

export async function markInfoTrack(tenantId: string, status: InfoTrackConnectionRow['status'], detail: string | null, by: string | null = null): Promise<void> {
  await runAsSystem(() =>
    query(
      `update infotrack_connection set status = $2, status_detail = $3, connected_by = coalesce($4, connected_by),
              connected_at = case when $2 = 'CONNECTED' then now() else connected_at end, updated_at = now()
        where tenant_id = $1`,
      [tenantId, status, detail, by]
    )
  );
  _clients.delete(tenantId);
}

/** Where InfoTrack posts a firm's results: the firm and its key ride the URL. */
export const infotrackWebhookUrl = (tenantId: string, key: string) =>
  `${config.appUrl}/api/v1/integrations/infotrack/webhook?firm=${encodeURIComponent(tenantId)}&key=${encodeURIComponent(key)}`;

export function infotrackClientFrom(creds: Omit<InfoTrackSavedCredentials, 'source'>, tenantId: string | null, opts: { maxRetries?: number } = {}): InfoTrackClient {
  return new InfoTrackClient({
    baseUrl: creds.baseUrl.replace(/\/+$/, ''),
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
    tokenUrl: creds.tokenUrl ?? undefined,
    webhookSecret: creds.signingSecret ?? undefined,
    callbackUrl: tenantId && creds.webhookKey ? infotrackWebhookUrl(tenantId, creds.webhookKey) : `${config.appUrl}/api/v1/integrations/infotrack/webhook`,
    ...opts,
  });
}

/** One client per firm (each keeps its own token), rebuilt when the firm's details change. */
const _clients = new Map<string, InfoTrackClient | null>();
export async function infotrackClientFor(tenantId: string): Promise<InfoTrackClient | null> {
  if (_clients.has(tenantId)) return _clients.get(tenantId)!;
  const r = await row(tenantId);
  // A firm that disconnected orders nothing on any account, the deployment's included.
  const creds = r && r.status !== 'CONNECTED' ? null : await infotrackCredentials(tenantId);
  const client = creds ? infotrackClientFrom(creds, creds.source === 'firm' ? tenantId : null) : null;
  _clients.set(tenantId, client);
  // Look again in a minute: a firm connecting or disconnecting on another server is picked up.
  setTimeout(() => _clients.delete(tenantId), 60_000).unref?.();
  return client;
}

/** The deployment-wide client, for results delivered to the old (firm-less) URL. */
export function infotrackClient(): InfoTrackClient {
  const env = envCredentials();
  if (!env) throw new Error('InfoTrack is not configured (INFOTRACK_BASE_URL / CLIENT_ID / CLIENT_SECRET).');
  return infotrackClientFrom({ ...env, webhookKey: null }, null);
}

/** The engine's search and ID check port: each firm on its own InfoTrack account, the stand-in for a firm with none. */
export function infotrackRouter(standIn: InfoTrackStandIn): FirmInfoTrackRouter {
  return new FirmInfoTrackRouter({ clientFor: infotrackClientFor }, new PgOrderStore(), pgMatterLookup, standIn);
}

/** Idempotency for provider retries: returns false if this delivery was already handled. */
export async function claimWebhookDelivery(provider: string, deliveryId: string): Promise<boolean> {
  const r = await query<{ id: string }>(`insert into integration_webhook (provider, delivery_id, status) values ($1,$2,'PROCESSING') on conflict (provider, delivery_id) do nothing returning id`, [provider, deliveryId]);
  return r.length > 0;
}

export async function finishWebhookDelivery(provider: string, deliveryId: string, status: 'PROCESSED' | 'IGNORED' | 'FAILED', detail: string | null): Promise<void> {
  await query(`update integration_webhook set status = $3, detail = $4 where provider = $1 and delivery_id = $2`, [provider, deliveryId, status, detail]).catch(() => {});
}
