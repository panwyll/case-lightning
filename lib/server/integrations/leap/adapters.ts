/**
 * Production wiring for LEAP as the backend: Postgres implementations of the token,
 * mirror and write-back stores; the DocumentRepository + bytes loader that make LEAP
 * the engine's file store; the ingest bridge; and the singletons the routes use.
 */
import crypto from 'node:crypto';
import { config } from '../../config';
import { query, queryOne, runAsAutomation, runAsSystem } from '../../db';
import { decryptSecret, encryptSecret } from '../../crypto';
import { PgDocumentBytesLoader, PgDocumentRepository } from '../../engine/pg-documents';
/** engine() / productionPorts() are imported lazily: engine/adapters imports this module's backend. */
const engineModule = () => import('../../engine/adapters');
import { ingestDocument } from '../../engine/ingest';
import type { DocumentRef, DocumentRepository } from '../../engine/ports';
import type { DocumentBytesLoader } from '../../engine/extraction';
import type { EngineDocumentInput } from '../../engine/llm';
import type { EngineEvent, MatterState } from '../../engine/types';
import { LeapHttpClient, type LeapApi, type LeapTokenStore } from './client';
import { contactRoleOf, DEFAULT_ENROL_PATTERNS } from './mapping';
import { handleLeapWebhook, routeByHint, syncMatters, syncOneMatter, type IngestHint, type IngestResult, type IngestStatus, type LeapMirrorStore, type SyncDeps, type SyncSummary } from './sync';
import { documentHint } from './mapping';
import { writeBack, type LeapWritebackStore, type WritebackKind } from './writeback';
import type { LeapDocument, LeapMatter, LeapMatterParty, LeapTokens, LeapWebhookEvent } from './types';
import { enrolIfUntracked } from '../../engine/enrol';

// Re-export so routes import one module.
export { syncMatters, syncOneMatter, handleLeapWebhook };
export type { SyncSummary };

/** The LEAP client for a firm. Injectable for tests/demos via setLeapApiFactory. */
let apiFactory: ((tenantId: string) => LeapApi) | null = null;

/** LEAP is the backend when it is configured, or a test/demo has injected a LeapApi factory. */
export function leapBackendActive(): boolean {
  return !!apiFactory || leapConfigured();
}

export function leapConfigured(): boolean {
  return !!(config.leapAuthBaseUrl && config.leapApiBaseUrl && config.leapClientId && config.leapClientSecret && config.appEncryptionKey);
}

export function leapClientConfig() {
  return {
    authBaseUrl: config.leapAuthBaseUrl!,
    apiBaseUrl: config.leapApiBaseUrl!,
    clientId: config.leapClientId!,
    clientSecret: config.leapClientSecret!,
    apiKey: config.leapApiKey ?? null,
    redirectUri: config.leapRedirectUri,
    webhookSecret: config.leapWebhookSecret ?? null,
  };
}

// ───────────────────────────── connection / tokens ─────────────────────────────

export interface LeapConnectionRow {
  tenantId: string;
  firmId: string | null;
  firmName: string | null;
  region: string | null;
  status: 'CONNECTED' | 'DISCONNECTED' | 'ERROR';
  statusDetail: string | null;
  webhookSubId: string | null;
  lastSyncAt: string | null;
  lastSyncDetail: SyncSummary | null;
  connectedAt: string | null;
}

export class PgLeapTokenStore implements LeapTokenStore {
  async load(tenantId: string): Promise<LeapTokens | null> {
    const r = await runAsSystem(() => queryOne<{ tokens_enc: string | null; status: string }>(`select tokens_enc, status from leap_connection where tenant_id = $1`, [tenantId]));
    if (!r?.tokens_enc || r.status === 'DISCONNECTED') return null;
    return JSON.parse(decryptSecret(r.tokens_enc)) as LeapTokens;
  }
  async save(tenantId: string, tokens: LeapTokens): Promise<void> {
    await runAsSystem(() => query(
      `insert into leap_connection (tenant_id, tokens_enc, status, status_detail, updated_at) values ($1,$2,'CONNECTED',null,now())
       on conflict (tenant_id) do update set tokens_enc = excluded.tokens_enc, status = 'CONNECTED', status_detail = null, updated_at = now()`,
      [tenantId, encryptSecret(JSON.stringify(tokens))]
    ));
  }
  async markDisconnected(tenantId: string, reason: string): Promise<void> {
    await runAsSystem(() => query(`update leap_connection set status = 'DISCONNECTED', status_detail = $2, updated_at = now() where tenant_id = $1`, [tenantId, reason]));
  }
}

export async function leapConnection(tenantId: string): Promise<LeapConnectionRow | null> {
  const r = await queryOne<{ tenant_id: string; firm_id: string | null; firm_name: string | null; region: string | null; status: LeapConnectionRow['status']; status_detail: string | null; webhook_sub_id: string | null; last_sync_at: Date | null; last_sync_detail: SyncSummary | null; connected_at: Date | null }>(
    `select tenant_id, firm_id, firm_name, region, status, status_detail, webhook_sub_id, last_sync_at, last_sync_detail, connected_at from leap_connection where tenant_id = $1`,
    [tenantId]
  );
  return r ? { tenantId: r.tenant_id, firmId: r.firm_id, firmName: r.firm_name, region: r.region, status: r.status, statusDetail: r.status_detail, webhookSubId: r.webhook_sub_id, lastSyncAt: r.last_sync_at?.toISOString() ?? null, lastSyncDetail: r.last_sync_detail, connectedAt: r.connected_at?.toISOString() ?? null } : null;
}

export async function setLeapConnectionMeta(tenantId: string, meta: { firmId?: string | null; firmName?: string | null; region?: string | null; webhookSubId?: string | null; connectedBy?: string | null }): Promise<void> {
  await runAsSystem(() => query(
    `update leap_connection set firm_id = coalesce($2, firm_id), firm_name = coalesce($3, firm_name), region = coalesce($4, region), webhook_sub_id = coalesce($5, webhook_sub_id), connected_by = coalesce($6, connected_by), connected_at = coalesce(connected_at, now()), updated_at = now() where tenant_id = $1`,
    [tenantId, meta.firmId ?? null, meta.firmName ?? null, meta.region ?? null, meta.webhookSubId ?? null, meta.connectedBy ?? null]
  ));
}

export async function disconnectLeap(tenantId: string, reason: string): Promise<void> {
  await runAsSystem(() => query(`update leap_connection set status = 'DISCONNECTED', status_detail = $2, tokens_enc = null, updated_at = now() where tenant_id = $1`, [tenantId, reason]));
}

/** Every firm with a live LEAP connection (the cron sweeps them). */
export async function connectedTenants(): Promise<string[]> {
  return (await runAsSystem(() => query<{ tenant_id: string }>(`select tenant_id from leap_connection where status = 'CONNECTED'`))).map((r) => r.tenant_id);
}

const clients = new Map<string, LeapHttpClient>();
export function setLeapApiFactory(f: ((tenantId: string) => LeapApi) | null): void {
  apiFactory = f;
  clients.clear();
}
export function leapApi(tenantId: string): LeapApi {
  if (apiFactory) return apiFactory(tenantId);
  if (!leapConfigured()) throw Object.assign(new Error('LEAP is not configured (LEAP_AUTH_BASE_URL / LEAP_API_BASE_URL / LEAP_CLIENT_ID / LEAP_CLIENT_SECRET / APP_ENCRYPTION_KEY).'), { status: 503 });
  let c = clients.get(tenantId);
  if (!c) {
    c = new LeapHttpClient(leapClientConfig(), tenantId, new PgLeapTokenStore());
    clients.set(tenantId, c);
  }
  return c;
}

// ───────────────────────────── mirror store ─────────────────────────────

export class PgLeapMirrorStore implements LeapMirrorStore {
  async upsertMatter(tenantId: string, m: LeapMatter, extras: { assignedTo: string | null; track: 'PURCHASE' | 'SALE'; createdBy: string | null }): Promise<{ matterId: string; created: boolean }> {
    return runAsSystem(async () => {
      const existing = await queryOne<{ id: string; assigned_to: string | null }>(`select id, assigned_to from matter where tenant_id = $1 and leap_matter_id = $2`, [tenantId, m.id]);
      const address = m.propertyAddress ?? m.description ?? m.number;
      if (existing) {
        await query(
          `update matter set property_address = $3, firm_ref = $4, exchange_target_date = $5, completion_target_date = $6, purchase_price = coalesce($7, purchase_price), assigned_to = coalesce($8, assigned_to), leap_synced_at = now(), updated_at = now(), status = case when status = 'CLOSED' then 'OPEN' else status end
            where id = $1 and tenant_id = $2`,
          [existing.id, tenantId, address, m.number, m.exchangeDate, m.completionDate, m.purchasePrice, extras.assignedTo]
        );
        return { matterId: existing.id, created: false, previousAssignedTo: existing.assigned_to };
      }
      // created_by is NOT NULL: fall back to the firm's first admin when LEAP's responsible staff has no account here.
      const creator = extras.createdBy ?? (await queryOne<{ id: string }>(`select id from app_user where tenant_id = $1 order by (role = 'ADMIN') desc, created_at asc limit 1`, [tenantId]))?.id;
      if (!creator) throw new Error('No user in this firm to own the mirrored matter.');
      const r = await queryOne<{ id: string }>(
        `insert into matter (tenant_id, matter_ref, property_address, buyer_names, seller_names, status, stage, track, created_by, assigned_to, firm_ref, exchange_target_date, completion_target_date, purchase_price, leap_matter_id, leap_synced_at, notes)
         values ($1,$2,$3,'{}','{}','OPEN','INSTRUCTION',$4,$5,$6,$7,$8,$9,$10,$11,now(),$12)
         on conflict (tenant_id, matter_ref) do update set leap_matter_id = excluded.leap_matter_id, property_address = excluded.property_address, leap_synced_at = now()
         returning id`,
        [tenantId, m.number, address, extras.track, creator, extras.assignedTo, m.number, m.exchangeDate, m.completionDate, m.purchasePrice, m.id, `Mirrored from LEAP (${m.matterType?.name ?? 'matter'}): ${m.description}`]
      );
      return { matterId: r!.id, created: true };
    }).then(async (res) => {
      if (res.created) await enrolIfUntracked(tenantId, res.matterId, extras.createdBy ?? 'system').catch(() => {});
      return res;
    });
  }

  async matterByLeapId(tenantId: string, leapMatterId: string) {
    const r = await runAsSystem(() => queryOne<{ id: string; leap_documents_since: Date | null }>(`select id, leap_documents_since from matter where tenant_id = $1 and leap_matter_id = $2`, [tenantId, leapMatterId]));
    return r ? { matterId: r.id, leapMatterId, documentsSince: r.leap_documents_since?.toISOString() ?? null } : null;
  }

  async closeMatter(tenantId: string, matterId: string): Promise<void> {
    await runAsSystem(() => query(`update matter set status = 'CLOSED', updated_at = now() where id = $1 and tenant_id = $2`, [matterId, tenantId]));
  }

  async upsertContacts(tenantId: string, matterId: string, parties: LeapMatterParty[]): Promise<void> {
    await runAsSystem(async () => {
      for (const p of parties) {
        const email = p.card.email ?? `${p.card.id}@leap.card`; // matter_contact needs an email key; cards without one get a stable placeholder
        await query(
          `insert into matter_contact (tenant_id, matter_id, email, name, role, source, phone, leap_card_id, leap_role, last_seen_at)
           values ($1,$2,$3,$4,$5,'LEAP',$6,$7,$8,now())
           on conflict (matter_id, email) do update set name = coalesce(excluded.name, matter_contact.name), role = excluded.role, phone = coalesce(excluded.phone, matter_contact.phone), leap_card_id = excluded.leap_card_id, leap_role = excluded.leap_role, last_seen_at = now()`,
          [tenantId, matterId, email, p.card.name || null, contactRoleOf(p.role), p.card.phone, p.card.id, p.rawRole]
        );
      }
      // Keep the legacy summary columns useful for the board.
      const buyers = parties.filter((p) => p.role === 'client').map((p) => p.card.name).filter(Boolean);
      const sellers = parties.filter((p) => p.role === 'other_side').map((p) => p.card.name).filter(Boolean);
      const otherSol = parties.find((p) => p.role === 'other_side_solicitor')?.card;
      const agent = parties.find((p) => p.role === 'agent')?.card;
      const lender = parties.find((p) => p.role === 'lender')?.card;
      await query(
        `update matter set buyer_names = case when $3::text[] <> '{}' then $3 else buyer_names end, seller_names = case when $4::text[] <> '{}' then $4 else seller_names end,
           counterparty_solicitor = coalesce($5, counterparty_solicitor), counterparty_agent = coalesce($6, counterparty_agent), lender = coalesce($7, lender),
           counterparty_ref = coalesce(counterparty_ref, case when $5 is not null then jsonb_build_object('kind','external','name',$5,'email',$8,'firm',$5) else null end)
          where id = $1 and tenant_id = $2`,
        [matterId, tenantId, buyers, sellers, otherSol?.organisation ?? otherSol?.name ?? null, agent?.organisation ?? agent?.name ?? null, lender?.organisation ?? lender?.name ?? null, otherSol?.email ?? null]
      ).catch(() => {});
    });
  }

  async upsertDocument(tenantId: string, matterId: string, d: LeapDocument): Promise<{ documentId: string; created: boolean }> {
    return runAsSystem(async () => {
      const existing = await queryOne<{ id: string }>(`select id from document where tenant_id = $1 and leap_document_id = $2`, [tenantId, d.id]);
      if (existing) {
        await query(`update document set file_name = $3, mime_type = coalesce($4, mime_type), size_bytes = coalesce($5, size_bytes) where id = $1 and tenant_id = $2`, [existing.id, tenantId, d.name, d.mimeType, d.sizeBytes]);
        return { documentId: existing.id, created: false };
      }
      const r = await queryOne<{ id: string }>(
        `insert into document (tenant_id, matter_id, source_type, storage_path, file_name, mime_type, size_bytes, doc_type, leap_document_id, created_at)
         values ($1,$2,'LEAP',$3,$4,$5,$6,$7,$8,coalesce($9::timestamptz, now())) returning id`,
        [tenantId, matterId, `leap://${d.matterId}/${d.folder ? `${d.folder}/` : ''}${d.name}`, d.name, d.mimeType, d.sizeBytes, d.category, d.id, d.createdAt]
      );
      return { documentId: r!.id, created: true };
    });
  }

  async markIngest(tenantId: string, documentId: string, status: IngestStatus, detail: string | null): Promise<void> {
    await runAsSystem(() => query(`update document set leap_ingest_status = $3, leap_ingest_detail = $4, leap_ingest_attempts = leap_ingest_attempts + 1 where id = $1 and tenant_id = $2`, [documentId, tenantId, status, detail]));
  }
  async pendingIngests(tenantId: string, matterId: string) {
    const rows = await runAsSystem(() => query<{ id: string; file_name: string; storage_path: string; doc_type: string | null; leap_ingest_attempts: number }>(
      `select id, file_name, storage_path, doc_type, leap_ingest_attempts from document where tenant_id = $1 and matter_id = $2 and leap_ingest_status = 'PENDING' order by created_at`,
      [tenantId, matterId]
    ));
    return rows.map((r) => ({ documentId: r.id, attempts: r.leap_ingest_attempts, hint: documentHint({ id: '', matterId: '', name: r.file_name, extension: null, mimeType: null, sizeBytes: null, folder: r.storage_path.replace(/^leap:\/\/[^/]+\//, '').split('/').slice(0, -1).join('/') || null, createdAt: null, updatedAt: null, createdBy: null, category: r.doc_type }) }));
  }

  async staffToUser(tenantId: string, staff: LeapMatter['responsibleStaff']): Promise<string | null> {
    if (!staff?.email) return null;
    const r = await runAsSystem(() => queryOne<{ id: string }>(`select id from app_user where tenant_id = $1 and lower(email) = lower($2)`, [tenantId, staff.email]));
    return r?.id ?? null;
  }

  async setMattersWatermark(tenantId: string, iso: string): Promise<void> {
    await runAsSystem(() => query(`update leap_connection set matters_since = $2, updated_at = now() where tenant_id = $1`, [tenantId, iso]));
  }
  async setDocumentsWatermark(tenantId: string, matterId: string, iso: string): Promise<void> {
    await runAsSystem(() => query(`update matter set leap_documents_since = $3 where id = $1 and tenant_id = $2`, [matterId, tenantId, iso]));
  }
  async enrolledMirrors(tenantId: string) {
    const rows = await runAsSystem(() => query<{ id: string; leap_matter_id: string; leap_documents_since: Date | null }>(
      `select m.id, m.leap_matter_id, m.leap_documents_since from matter m join matter_engine_state s on s.matter_id = m.id
        where m.tenant_id = $1 and m.leap_matter_id is not null and m.status <> 'CLOSED' and s.finished_at is null`,
      [tenantId]
    ));
    return rows.map((r) => ({ matterId: r.id, leapMatterId: r.leap_matter_id, documentsSince: r.leap_documents_since?.toISOString() ?? null }));
  }
  async mattersWatermark(tenantId: string): Promise<string | null> {
    const r = await runAsSystem(() => queryOne<{ matters_since: Date | null }>(`select matters_since from leap_connection where tenant_id = $1`, [tenantId]));
    return r?.matters_since?.toISOString() ?? null;
  }
  async recordSync(tenantId: string, detail: SyncSummary): Promise<void> {
    await runAsSystem(() => query(`update leap_connection set last_sync_at = now(), last_sync_detail = $2::jsonb, updated_at = now() where tenant_id = $1`, [tenantId, JSON.stringify(detail)]));
  }
}

// ───────────────────────────── documents: LEAP is the file store ─────────────────────────────

/**
 * The engine's DocumentRepository when LEAP is the backend. Metadata is the mirrored
 * `document` row; bytes come from LEAP on demand (LeapDocumentBytesLoader). Engine-
 * generated documents (report DRAFTS, escalation dossiers) are uploaded into the LEAP
 * matter — clearly labelled — so the handler sees them in the case file, and the
 * decision still cites a document that exists in the firm's system of record.
 */
export class LeapDocumentRepository implements DocumentRepository {
  constructor(private pg = new PgDocumentRepository(), private mirror = new PgLeapMirrorStore()) {}

  get(tenantId: string, documentId: string): Promise<DocumentRef | null> {
    return this.pg.get(tenantId, documentId);
  }

  async createGenerated(input: { tenantId: string; matterId: string; docType: string; fileName: string; content: string; createdBy?: string | null }): Promise<DocumentRef> {
    const doc = await this.pg.createGenerated(input);
    if (!config.leapUploadGenerated) return doc;
    const link = await queryOne<{ leap_matter_id: string | null }>(`select leap_matter_id from matter where id = $1 and tenant_id = $2`, [input.matterId, input.tenantId]).catch(() => null);
    if (!link?.leap_matter_id) return doc;
    try {
      const isDraft = /DRAFT/i.test(input.docType);
      const fileName = `${isDraft ? 'DRAFT - ' : ''}${input.fileName.replace(/\.txt$/, '')} (CONVEYi).txt`;
      const up = await leapApi(input.tenantId).uploadDocument(link.leap_matter_id, { fileName, mimeType: 'text/plain', bytes: Buffer.from(input.content, 'utf8'), folder: 'CONVEYi', category: input.docType });
      await query(`update document set leap_document_id = $3, storage_path = $4 where id = $1 and tenant_id = $2`, [doc.id, input.tenantId, up.id, `leap://${link.leap_matter_id}/CONVEYi/${fileName}`]);
    } catch (err) {
      console.warn('[leap] could not upload a generated document; it remains local', (err as Error).message);
    }
    return doc;
  }
}

/** Bytes for the extractor: LEAP download for mirrored documents, the local loader for everything else. */
export class LeapDocumentBytesLoader implements DocumentBytesLoader {
  private cache = new Map<string, { at: number; input: EngineDocumentInput }>();
  constructor(private fallback = new PgDocumentBytesLoader()) {}

  async load(doc: DocumentRef): Promise<EngineDocumentInput | null> {
    const inline = (doc.extractedFacts as { content?: string } | null)?.content;
    if (typeof inline === 'string' && inline.length) return { kind: 'text', data: inline, title: doc.fileName ?? undefined };
    const row = await queryOne<{ leap_document_id: string | null; mime_type: string | null }>(`select leap_document_id, mime_type from document where id = $1 and tenant_id = $2`, [doc.id, doc.tenantId]).catch(() => null);
    if (!row?.leap_document_id) return this.fallback.load(doc);
    const hit = this.cache.get(doc.id);
    if (hit && Date.now() - hit.at < 300_000) return hit.input;
    const dl = await leapApi(doc.tenantId).downloadDocument(row.leap_document_id);
    const mime = dl.mimeType ?? row.mime_type ?? '';
    const name = doc.fileName ?? dl.fileName ?? '';
    let input: EngineDocumentInput | null = null;
    if (mime.includes('pdf') || /\.pdf$/i.test(name)) input = { kind: 'pdf', data: dl.bytes.toString('base64'), title: name || undefined };
    else if (/^image\//.test(mime) || /\.(png|jpe?g|gif|webp)$/i.test(name)) input = { kind: 'image', data: dl.bytes.toString('base64'), mimeType: mime || 'image/jpeg', title: name || undefined };
    else if (mime.startsWith('text/') || /\.(txt|md|csv)$/i.test(name)) input = { kind: 'text', data: dl.bytes.toString('utf8').slice(0, 200_000), title: name || undefined };
    if (input) this.cache.set(doc.id, { at: Date.now(), input });
    return input;
  }
}

/** Serve a mirrored document's bytes to the decision panel (the /raw route) straight from LEAP. */
export async function leapDocumentBytes(tenantId: string, documentId: string): Promise<{ bytes: Buffer; mimeType: string | null; fileName: string | null } | null> {
  const row = await queryOne<{ leap_document_id: string | null }>(`select leap_document_id from document where id = $1 and tenant_id = $2`, [documentId, tenantId]).catch(() => null);
  if (!row?.leap_document_id) return null;
  return leapApi(tenantId).downloadDocument(row.leap_document_id);
}

// ───────────────────────────── ingest bridge ─────────────────────────────

/**
 * Hand a mirrored LEAP document to the engine. With a classifier (Claude key) the
 * pipeline decides; without one — or when it is unsure — LEAP's folder/file name is a
 * strong enough prior to route a search result, an offer, a title or an ID report.
 */
export async function ingestLeapDocument(tenantId: string, matterId: string, documentId: string, hint: IngestHint): Promise<IngestResult> {
  const { engine, productionPorts } = await engineModule();
  const ports = productionPorts();
  const svc = engine();
  const doc = await ports.documents.get(tenantId, documentId);
  if (!doc) return { status: 'SKIPPED', detail: 'document not found' };
  return runAsAutomation(async () => {
    if (ports.classifier) {
      const report = await ingestDocument(svc, ports, tenantId, matterId, doc);
      if (report.action.kind !== 'skip') return { status: 'DONE', detail: `${report.action.kind} via classifier` };
    }
    return routeByHint(svc, tenantId, matterId, documentId, hint);
  });
}

// ───────────────────────────── write-back store ─────────────────────────────

export class PgLeapWritebackStore implements LeapWritebackStore {
  async find(eventId: string, kind: WritebackKind) {
    const r = await runAsSystem(() => queryOne<{ leap_id: string | null; status: string }>(`select leap_id, status from leap_writeback where event_id = $1 and kind = $2`, [eventId, kind]));
    return r ? { leapId: r.leap_id, status: r.status } : null;
  }
  async record(input: { tenantId: string; matterId: string; eventId: string; kind: WritebackKind; leapId: string | null; status: 'WRITTEN' | 'COMPLETED' | 'FAILED'; detail?: string | null }): Promise<void> {
    await runAsSystem(() => query(
      `insert into leap_writeback (tenant_id, matter_id, event_id, kind, leap_id, status, detail) values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (event_id, kind) do update set leap_id = coalesce(excluded.leap_id, leap_writeback.leap_id), status = excluded.status, detail = excluded.detail, updated_at = now()`,
      [input.tenantId, input.matterId, input.eventId, input.kind, input.leapId, input.status, input.detail ?? null]
    ));
  }
  async leapMatter(tenantId: string, matterId: string) {
    const r = await runAsSystem(() => queryOne<{ leap_matter_id: string | null }>(`select leap_matter_id from matter where id = $1 and tenant_id = $2`, [matterId, tenantId]));
    return r?.leap_matter_id ? { leapMatterId: r.leap_matter_id, staffId: null } : null;
  }
  async userName(tenantId: string, userId: string): Promise<string | null> {
    const r = await runAsSystem(() => queryOne<{ name: string }>(`select coalesce(display_name, email) as name from app_user where id = $1 and tenant_id = $2`, [userId, tenantId]));
    return r?.name ?? null;
  }
}

export function leapWritebackEnabled(): boolean {
  return config.leapWriteback === 'on' || (config.leapWriteback === 'auto' && (leapConfigured() || !!apiFactory));
}

/** The post-commit observer wired into the engine when LEAP is the backend. */
export async function leapOnEvents(input: { tenantId: string; matterId: string; events: EngineEvent[]; state: MatterState }): Promise<void> {
  if (!leapWritebackEnabled()) return;
  const conn = await leapConnection(input.tenantId).catch(() => null);
  if (!apiFactory && conn?.status !== 'CONNECTED') return;
  const { engine } = await engineModule();
  await writeBack({ leap: leapApi(input.tenantId), store: new PgLeapWritebackStore(), appUrl: config.appUrl, subflows: (t) => engine().subflows(t), log: (m, d) => console.warn(`[leap] ${m}`, d instanceof Error ? d.message : d ?? '') }, input.tenantId, input.matterId, input.events, input.state);
}

// ───────────────────────────── sync deps ─────────────────────────────

export async function leapSyncDeps(tenantId: string): Promise<SyncDeps> {
  const patterns = config.leapEnrolPatterns ? config.leapEnrolPatterns.split('|').map((p) => new RegExp(p.trim(), 'i')) : DEFAULT_ENROL_PATTERNS;
  const { engine } = await engineModule();
  return {
    leap: leapApi(tenantId),
    store: new PgLeapMirrorStore(),
    engine: engine(),
    ingest: ingestLeapDocument,
    policy: { patterns, shadow: config.leapEnrolMode !== 'live' },
    now: () => new Date(),
    log: (m, d) => console.warn(`[leap] ${m}`, d instanceof Error ? d.message : d ?? ''),
  };
}

/** Idempotency for LEAP's retries. */
export async function claimLeapDelivery(deliveryId: string): Promise<boolean> {
  const r = await runAsSystem(() => query<{ id: string }>(`insert into integration_webhook (provider, delivery_id, status) values ('leap', $1, 'PROCESSING') on conflict (provider, delivery_id) do nothing returning id`, [deliveryId]));
  return r.length > 0;
}
export async function finishLeapDelivery(deliveryId: string, status: 'PROCESSED' | 'IGNORED' | 'FAILED', detail: string | null): Promise<void> {
  await runAsSystem(() => query(`update integration_webhook set status = $2, detail = $3 where provider = 'leap' and delivery_id = $1`, [deliveryId, status, detail])).catch(() => {});
}

/** Which firm a webhook belongs to: LEAP's firm id → our tenant (one connection per firm). */
export async function tenantForLeapFirm(firmId: string | null): Promise<string | null> {
  if (!firmId) {
    const all = await connectedTenants();
    return all.length === 1 ? all[0] : null; // single-tenant deployments need no firm id in the payload
  }
  const r = await runAsSystem(() => queryOne<{ tenant_id: string }>(`select tenant_id from leap_connection where firm_id = $1 and status = 'CONNECTED'`, [firmId]));
  return r?.tenant_id ?? null;
}

export function parseLeapWebhook(raw: string, deliveryHeader: string | null): LeapWebhookEvent {
  return LeapHttpClient.parseWebhook(raw, deliveryHeader);
}

export function pkceState(): { state: string; verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { state: crypto.randomBytes(16).toString('hex'), verifier, challenge };
}
