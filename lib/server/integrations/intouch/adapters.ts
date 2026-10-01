/**
 * The production wiring for InTouch: the firm's API key, the Postgres-backed mirror
 * store, the client, and the small helpers the API routes use.
 *
 * Everything here runs as the automation role with no user bound (runAsSystem): a sync or
 * a webhook has no signed-in person behind it, and the database's own enforcement means
 * nothing arriving from InTouch can write a payment or a send event however it is shaped.
 */
import crypto from 'node:crypto';
import { query, queryOne, runAsSystem } from '../../db';
import { putBlob } from '../../blob-store';
import { encryptSecret, decryptSecret } from '../../crypto';
import { config } from '../../config';
import { paths } from '../../../paths';
import { engine } from '../../engine/adapters';
import { InTouchHttpClient, type InTouchApi, type InTouchClientConfig } from './client';
import type { InTouchWritebackStore } from './writeback';
import type { EngineEvent } from '../../engine/types';
import { InTouchError } from './types';
import type { InTouchCase, InTouchConnectionRow, InTouchDocument, InTouchParty, InTouchSyncSummary } from './types';
import type { InTouchMirrorRef, InTouchMirrorStore, InTouchSyncDeps } from './sync';
import { enrolIfUntracked } from '../../engine/enrol';

/**
 * A firm's own InTouch credentials: which InTouch host it is on, the API key it generated
 * in InTouch (Settings > API > Keys), and the key WE generated that authenticates its
 * webhooks — InTouch does not sign deliveries, so the per-firm URL carries a secret.
 * Entered by the firm's admin on the InTouch page and stored encrypted
 * (intouch_connection.credentials_enc); INTOUCH_API_BASE_URL + INTOUCH_API_TOKEN are only
 * a fallback for a deployment that serves one firm.
 */
export interface InTouchFirmCredentials {
  apiBaseUrl: string;
  apiToken: string;
  webhookKey: string;
}

export type InTouchSavedCredentials = Omit<InTouchFirmCredentials, 'webhookKey'> & {
  /** Null only for the env fallback before the firm has pressed Connect. */
  webhookKey: string | null;
  source: 'firm' | 'deployment';
};

function envCredentials(): Omit<InTouchSavedCredentials, 'source'> | null {
  if (!config.intouchApiBaseUrl || !config.intouchApiToken) return null;
  return { apiBaseUrl: config.intouchApiBaseUrl, apiToken: config.intouchApiToken, webhookKey: null };
}

/** The firm's saved row, decrypted. An old-shaped row (OAuth era, no apiToken) reads as partial. */
async function savedRow(tenantId: string): Promise<Partial<InTouchFirmCredentials> | null> {
  const r = await runAsSystem(() => queryOne<{ credentials_enc: string | null }>(`select credentials_enc from intouch_connection where tenant_id = $1`, [tenantId])).catch(() => null);
  if (!r?.credentials_enc) return null;
  try {
    return JSON.parse(decryptSecret(r.credentials_enc)) as Partial<InTouchFirmCredentials>;
  } catch {
    return null;
  }
}

/**
 * The firm's saved credentials, then the deployment's; null when neither exists. A saved
 * row without an API key (the old OAuth shape) is not a connection.
 */
export async function inTouchCredentials(tenantId: string): Promise<InTouchSavedCredentials | null> {
  const row = await savedRow(tenantId);
  if (row?.apiBaseUrl && row.apiToken) return { apiBaseUrl: row.apiBaseUrl, apiToken: row.apiToken, webhookKey: row.webhookKey ?? null, source: 'firm' };
  const env = envCredentials();
  return env ? { ...env, webhookKey: row?.webhookKey ?? null, source: 'deployment' } : null;
}

/** The key the firm's webhook URL must carry, or null when none has been issued. */
export async function inTouchWebhookKey(tenantId: string): Promise<string | null> {
  return (await savedRow(tenantId))?.webhookKey ?? null;
}

/** Save the address and key; the webhook key is generated once and then kept. */
export async function saveInTouchCredentials(tenantId: string, creds: { apiBaseUrl: string; apiToken: string }): Promise<InTouchFirmCredentials> {
  const webhookKey = (await savedRow(tenantId))?.webhookKey ?? crypto.randomBytes(32).toString('hex');
  const full: InTouchFirmCredentials = { apiBaseUrl: creds.apiBaseUrl, apiToken: creds.apiToken, webhookKey };
  await runAsSystem(() =>
    query(
      `insert into intouch_connection (tenant_id, credentials_enc, updated_at) values ($1,$2,now())
       on conflict (tenant_id) do update set credentials_enc = excluded.credentials_enc, updated_at = now()`,
      [tenantId, encryptSecret(JSON.stringify(full))]
    )
  );
  return full;
}

export async function markInTouchError(tenantId: string, detail: string): Promise<void> {
  await runAsSystem(() => query(`update intouch_connection set status = 'ERROR', status_detail = $2, updated_at = now() where tenant_id = $1`, [tenantId, detail]));
}

/** InTouch accepted the key (account() read back): the connection is live. */
export async function markInTouchConnected(tenantId: string, meta: { accountId: string | null; accountName: string | null; connectedBy: string | null }): Promise<void> {
  await runAsSystem(() =>
    query(
      `update intouch_connection set status = 'CONNECTED', status_detail = null, account_id = $2, account_name = $3,
              connected_by = coalesce($4, connected_by), connected_at = now(), updated_at = now()
        where tenant_id = $1`,
      [tenantId, meta.accountId, meta.accountName, meta.connectedBy]
    )
  );
}

export function inTouchClientConfig(creds: { apiBaseUrl: string; apiToken: string }): InTouchClientConfig {
  return { apiBaseUrl: creds.apiBaseUrl, apiToken: creds.apiToken };
}

export async function inTouchClient(tenantId: string): Promise<InTouchApi & InTouchHttpClient> {
  const creds = await inTouchCredentials(tenantId);
  if (!creds) throw new InTouchError('InTouch is not connected for this firm — connect it from the integrations page.', 503, false);
  return new InTouchHttpClient(inTouchClientConfig(creds), tenantId);
}

export async function inTouchConnection(tenantId: string): Promise<InTouchConnectionRow | null> {
  type Row = { tenant_id: string; account_id: string | null; account_name: string | null; status: InTouchConnectionRow['status']; status_detail: string | null; last_sync_at: Date | null; last_sync_detail: InTouchSyncSummary | null; connected_at: Date | null; milestones_enabled: boolean; documents_writeback?: boolean; notes_writeback?: boolean };
  const cols = 'tenant_id, account_id, account_name, status, status_detail, last_sync_at, last_sync_detail, connected_at, milestones_enabled';
  // Before migration 119 the write-back columns do not exist yet: read without them rather than fail the page.
  const r = await queryOne<Row>(`select ${cols}, documents_writeback, notes_writeback from intouch_connection where tenant_id = $1`, [tenantId])
    .catch((err: { code?: string }) => (err?.code === '42703' ? queryOne<Row>(`select ${cols} from intouch_connection where tenant_id = $1`, [tenantId]) : Promise.reject(err)));
  if (!r) return null;
  const creds = await inTouchCredentials(tenantId);
  const key = creds?.webhookKey ?? null;
  return {
    tenantId: r.tenant_id,
    accountId: r.account_id,
    accountName: r.account_name,
    // An old-shaped row (no API key) is not a connection, whatever its status says.
    status: r.status === 'CONNECTED' && !creds ? 'DISCONNECTED' : r.status,
    statusDetail: r.status_detail,
    webhookUrl: key ? inTouchWebhookUrl(tenantId, key) : null,
    lastSyncAt: r.last_sync_at?.toISOString() ?? null,
    lastSyncDetail: r.last_sync_detail,
    connectedAt: r.connected_at?.toISOString() ?? null,
    milestonesEnabled: r.milestones_enabled,
    documentsWriteback: !!r.documents_writeback,
    notesWriteback: !!r.notes_writeback,
  };
}

export async function setInTouchConnectionMeta(tenantId: string, meta: { accountId?: string | null; accountName?: string | null; connectedBy?: string | null; milestonesEnabled?: boolean; documentsWriteback?: boolean; notesWriteback?: boolean }): Promise<void> {
  await runAsSystem(() =>
    query(
      `update intouch_connection set account_id = coalesce($2, account_id), account_name = coalesce($3, account_name),
              connected_by = coalesce($4, connected_by), milestones_enabled = coalesce($5, milestones_enabled),
              documents_writeback = coalesce($6, documents_writeback), notes_writeback = coalesce($7, notes_writeback),
              connected_at = coalesce(connected_at, now()), updated_at = now()
        where tenant_id = $1`,
      [tenantId, meta.accountId ?? null, meta.accountName ?? null, meta.connectedBy ?? null, meta.milestonesEnabled ?? null, meta.documentsWriteback ?? null, meta.notesWriteback ?? null]
    )
  );
}

/** Stop reading and pushing. The saved address, key and webhook key stay, so reconnecting is one click. */
export async function disconnectInTouch(tenantId: string): Promise<void> {
  const set = "status = 'DISCONNECTED', status_detail = 'Disconnected by the firm', milestones_enabled = false, updated_at = now()";
  await runAsSystem(() => query(`update intouch_connection set ${set}, documents_writeback = false, notes_writeback = false where tenant_id = $1`, [tenantId])
    .catch((err: { code?: string }) => (err?.code === '42703' ? query(`update intouch_connection set ${set} where tenant_id = $1`, [tenantId]) : Promise.reject(err))));
}

/** InTouch's side → the matter track the rest of CaseLightning uses. */
const TRACK: Record<string, 'PURCHASE' | 'SALE'> = { purchase: 'PURCHASE', sale: 'SALE', remortgage: 'PURCHASE', transfer: 'PURCHASE', unknown: 'PURCHASE' };

const CONTACT_ROLE: Record<InTouchParty['role'], string> = {
  client: 'CLIENT',
  joint_client: 'CLIENT',
  other_side: 'OTHER_PARTY',
  other_side_solicitor: 'OTHER_SOLICITOR',
  estate_agent: 'AGENT',
  broker: 'OTHER',
  lender: 'LENDER',
  other: 'OTHER',
};

/** Write-back's store (writeback.ts): the firm's switches, what is left to send, and what was sent. */
export class PgInTouchWritebackStore implements InTouchWritebackStore {
  async writebackOptions(tenantId: string): Promise<{ documents: boolean; notes: boolean }> {
    const r = await runAsSystem(() => queryOne<{ documents_writeback: boolean; notes_writeback: boolean; status: string }>(`select documents_writeback, notes_writeback, status from intouch_connection where tenant_id = $1`, [tenantId]).catch(() => null));
    return r?.status === 'CONNECTED' ? { documents: !!r.documents_writeback, notes: !!r.notes_writeback } : { documents: false, notes: false };
  }
  async outgoingDocuments(tenantId: string, matterId: string): Promise<Array<{ id: string; fileName: string; docType: string | null }>> {
    return runAsSystem(() => query<{ id: string; fileName: string; docType: string | null }>(
      `select id, file_name as "fileName", doc_type as "docType" from document
        where tenant_id = $1 and matter_id = $2 and intouch_document_id is null and source_type <> 'INTOUCH' and superseded_at is null
        order by created_at limit 25`, [tenantId, matterId]));
  }
  async documentBytes(tenantId: string, documentId: string) {
    const { fileBytes } = await import('../../engine/file-finder');
    return runAsSystem(() => fileBytes(tenantId, documentId));
  }
  async documentSent(tenantId: string, matterId: string, documentId: string, intouchId: string): Promise<void> {
    // Stamped with InTouch's id: the next sync finds it already here and never mirrors it back.
    await runAsSystem(() => query(`update document set intouch_document_id = $3 where id = $2 and tenant_id = $1 and intouch_document_id is null`, [tenantId, documentId, intouchId]));
    await runAsSystem(() => query(`insert into intouch_applied (tenant_id, matter_id, kind, external_id, detail) values ($1,$2,'document_out',$3,$4) on conflict do nothing`, [tenantId, matterId, documentId, intouchId]));
  }
  async unnotedEvents(tenantId: string, matterId: string, types: string[]): Promise<EngineEvent[]> {
    const rows = await runAsSystem(() => query<{ id: string; seq: string; type: string; actor: string; payload: Record<string, unknown>; created_at: Date }>(
      `select e.id, e.seq::text as seq, e.type, e.actor, e.payload, e.created_at from matter_event e
        where e.tenant_id = $1 and e.matter_id = $2 and e.type = any($3::text[])
          and not exists (select 1 from intouch_applied a where a.tenant_id = $1 and a.kind = 'note_out' and a.external_id = e.id::text)
        order by e.seq limit 50`, [tenantId, matterId, types]));
    return rows.map((r) => ({ id: r.id, seq: Number(r.seq), type: r.type, actor: r.actor, payload: r.payload, createdAt: r.created_at.toISOString(), tenantId, matterId }) as unknown as EngineEvent);
  }
  async eventNoted(tenantId: string, matterId: string, eventId: string): Promise<void> {
    await runAsSystem(() => query(`insert into intouch_applied (tenant_id, matter_id, kind, external_id) values ($1,$2,'note_out',$3) on conflict do nothing`, [tenantId, matterId, eventId]));
  }
}

export class PgInTouchMirrorStore implements InTouchMirrorStore {
  readonly writeback = new PgInTouchWritebackStore();
  async upsertMatter(tenantId: string, c: InTouchCase, extras: { assignedTo: string | null; createdBy: string | null }): Promise<{ matterId: string; created: boolean }> {
    return runAsSystem(async () => {
      const existing = await queryOne<{ id: string }>(`select id from matter where tenant_id = $1 and intouch_case_id = $2`, [tenantId, c.id]);
      const address = c.propertyAddress ?? c.reference;
      const price = c.pricePennies == null ? null : String(c.pricePennies / 100);
      if (existing) {
        await query(
          `update matter set property_address = coalesce($3, property_address), purchase_price = coalesce($4, purchase_price),
                  assigned_to = coalesce($5, assigned_to), intouch_synced_at = now(), updated_at = now(),
                  status = case when status = 'CLOSED' and $6 then 'OPEN' else status end
             where id = $1 and tenant_id = $2`,
          [existing.id, tenantId, address, price, extras.assignedTo, c.status === 'active' || c.status === 'instructed']
        );
        return { matterId: existing.id, created: false };
      }
      // created_by is NOT NULL: fall back to the firm's first admin when InTouch's fee
      // earner has no account here.
      const creator = extras.createdBy ?? (await queryOne<{ id: string }>(`select id from app_user where tenant_id = $1 order by (role = 'ADMIN') desc, created_at asc limit 1`, [tenantId]))?.id;
      if (!creator) throw new Error('No user in this firm to own the mirrored case.');
      // The firm's own reference wins where it typed one into InTouch; otherwise InTouch's.
      const ref = c.firmReference || c.reference;
      const r = await queryOne<{ id: string }>(
        `insert into matter (tenant_id, matter_ref, property_address, buyer_names, seller_names, status, stage, track, created_by, assigned_to, firm_ref, purchase_price, intouch_case_id, intouch_synced_at, notes)
         values ($1,$2,$3,'{}','{}','OPEN','INSTRUCTION',$4,$5,$6,$7,$8,$9,now(),$10)
         on conflict (tenant_id, matter_ref) do update set intouch_case_id = excluded.intouch_case_id, property_address = excluded.property_address, intouch_synced_at = now()
         returning id`,
        [tenantId, ref, address, TRACK[c.side] ?? 'PURCHASE', creator, extras.assignedTo, c.firmReference, price, c.id, `Mirrored from InTouch (${c.side} · ${c.tenure}) — case ${c.reference}`]
      );
      return { matterId: r!.id, created: true };
    }).then(async (res) => {
      if (res.created) await enrolIfUntracked(tenantId, res.matterId, extras.createdBy ?? 'system').catch(() => {});
      return res;
    });
  }

  async matterByCaseId(tenantId: string, intouchCaseId: string): Promise<InTouchMirrorRef | null> {
    const r = await runAsSystem(() => queryOne<{ id: string; intouch_milestone: string | null }>(`select id, intouch_milestone from matter where tenant_id = $1 and intouch_case_id = $2`, [tenantId, intouchCaseId]));
    return r ? { matterId: r.id, intouchCaseId, lastMilestone: r.intouch_milestone } : null;
  }

  async matterByContactEmail(tenantId: string, email: string): Promise<InTouchMirrorRef | null> {
    const rows = await runAsSystem(() =>
      query<{ id: string; intouch_case_id: string; intouch_milestone: string | null }>(
        `select distinct m.id, m.intouch_case_id, m.intouch_milestone
           from matter m
           join matter_contact mc on mc.matter_id = m.id and mc.tenant_id = m.tenant_id
          where m.tenant_id = $1 and m.intouch_case_id is not null and m.status <> 'CLOSED'
            and lower(mc.email) = lower($2)
            -- the firm's own people are on every case: never a signal (matching self-address rule)
            and not exists (select 1 from app_user u where u.tenant_id = $1 and lower(u.email) = lower($2))
          limit 2`,
        [tenantId, email]
      )
    );
    if (rows.length !== 1) return null;
    return { matterId: rows[0].id, intouchCaseId: rows[0].intouch_case_id, lastMilestone: rows[0].intouch_milestone };
  }

  async upsertContacts(tenantId: string, matterId: string, parties: InTouchParty[]): Promise<void> {
    await runAsSystem(async () => {
      for (const p of parties) {
        // matter_contact is keyed on email; a party without one gets a stable placeholder
        // rather than being dropped.
        const email = p.email ?? `${p.id}@intouch.party`;
        await query(
          `insert into matter_contact (tenant_id, matter_id, email, name, role, source, phone, intouch_party_id, last_seen_at)
           values ($1,$2,$3,$4,$5,'INTOUCH',$6,$7,now())
           on conflict (matter_id, email) do update set name = coalesce(excluded.name, matter_contact.name),
                 -- InTouch updates its own contacts and adopts ones first seen on email; a role or
                 -- phone a person entered here is theirs (migration 079 refuses the overwrite).
                 role = case when matter_contact.role = 'UNKNOWN' or matter_contact.source = 'INTOUCH' then excluded.role else matter_contact.role end,
                 phone = case when matter_contact.phone is null or matter_contact.source = 'INTOUCH' then coalesce(excluded.phone, matter_contact.phone) else matter_contact.phone end,
                 source = case when matter_contact.source is null or matter_contact.source like 'EMAIL%' then 'INTOUCH' else matter_contact.source end,
                 intouch_party_id = excluded.intouch_party_id, last_seen_at = now()`,
          [tenantId, matterId, email, p.name || null, CONTACT_ROLE[p.role] ?? 'OTHER', p.phone, p.id]
        );
      }
    });
  }

  async upsertDocument(tenantId: string, matterId: string, d: InTouchDocument, fetchBytes: () => Promise<{ bytes: Buffer; mimeType: string | null; fileName: string | null }>): Promise<{ documentId: string; created: boolean }> {
    return runAsSystem(async () => {
      const existing = await queryOne<{ id: string }>(`select id from document where tenant_id = $1 and intouch_document_id = $2`, [tenantId, d.id]);
      if (existing) return { documentId: existing.id, created: false };
      const r = await queryOne<{ id: string }>(
        `insert into document (tenant_id, matter_id, source_type, storage_path, file_name, mime_type, size_bytes, doc_type, intouch_document_id, created_at)
         values ($1,$2,'INTOUCH',$3,$4,$5,$6,$7,$8,coalesce($9::timestamptz, now())) returning id`,
        [tenantId, matterId, `intouch://${d.caseId}/${d.id}`, d.fileName, d.mimeType, d.sizeBytes, (d.category ?? 'CLIENT_UPLOAD').toUpperCase().replace(/[^A-Z0-9]+/g, '_'), d.id, d.createdAt]
      );
      // Keep the bytes: a decision has to be able to show the client's own document, and
      // InTouch is not guaranteed to still hold it when someone opens the panel next year.
      try {
        const { bytes } = await fetchBytes();
        await putBlob(tenantId, r!.id, bytes);
      } catch {
        /* the row stands without bytes; the panel falls back to a link, and the next sync retries */
      }
      return { documentId: r!.id, created: true };
    });
  }

  async feeEarnerToUser(tenantId: string, fe: InTouchCase['feeEarner']): Promise<string | null> {
    if (!fe?.email) return null;
    const r = await runAsSystem(() => queryOne<{ id: string }>(`select id from app_user where tenant_id = $1 and lower(email) = lower($2)`, [tenantId, fe.email!]));
    return r?.id ?? null;
  }

  async seen(tenantId: string, kind: 'identity_check' | 'form' | 'document' | 'milestone', externalId: string): Promise<boolean> {
    const r = await runAsSystem(() => queryOne<{ id: string }>(`select id from intouch_applied where tenant_id = $1 and kind = $2 and external_id = $3`, [tenantId, kind, externalId]));
    return !!r;
  }

  async markSeen(tenantId: string, matterId: string, kind: 'identity_check' | 'form' | 'document' | 'milestone', externalId: string, detail?: string | null): Promise<void> {
    await runAsSystem(() =>
      query(`insert into intouch_applied (tenant_id, matter_id, kind, external_id, detail) values ($1,$2,$3,$4,$5) on conflict (tenant_id, kind, external_id) do nothing`, [tenantId, matterId, kind, externalId, detail ?? null])
    );
  }

  async setMilestone(tenantId: string, matterId: string, milestone: string): Promise<void> {
    await runAsSystem(() => query(`update matter set intouch_milestone = $3 where id = $1 and tenant_id = $2`, [matterId, tenantId, milestone]));
  }

  async casesWatermark(tenantId: string): Promise<string | null> {
    const r = await runAsSystem(() => queryOne<{ cases_since: Date | null }>(`select cases_since from intouch_connection where tenant_id = $1`, [tenantId]));
    return r?.cases_since?.toISOString() ?? null;
  }

  async setCasesWatermark(tenantId: string, iso: string): Promise<void> {
    await runAsSystem(() => query(`update intouch_connection set cases_since = $2, updated_at = now() where tenant_id = $1`, [tenantId, iso]));
  }

  async mirrors(tenantId: string): Promise<InTouchMirrorRef[]> {
    const rows = await runAsSystem(() =>
      query<{ id: string; intouch_case_id: string; intouch_milestone: string | null }>(
        `select id, intouch_case_id, intouch_milestone from matter where tenant_id = $1 and intouch_case_id is not null and status <> 'CLOSED'`,
        [tenantId]
      )
    );
    return rows.map((r) => ({ matterId: r.id, intouchCaseId: r.intouch_case_id, lastMilestone: r.intouch_milestone }));
  }

  async recordSync(tenantId: string, detail: InTouchSyncSummary): Promise<void> {
    await runAsSystem(() => query(`update intouch_connection set last_sync_at = now(), last_sync_detail = $2::jsonb, updated_at = now() where tenant_id = $1`, [tenantId, JSON.stringify(detail)]));
  }

  async milestonesEnabled(tenantId: string): Promise<boolean> {
    const r = await runAsSystem(() => queryOne<{ milestones_enabled: boolean }>(`select milestones_enabled from intouch_connection where tenant_id = $1`, [tenantId]));
    return !!r?.milestones_enabled;
  }
}

/** The dependency bundle the sync and the webhook both use. */
export async function inTouchSyncDeps(tenantId: string): Promise<InTouchSyncDeps> {
  return {
    api: await inTouchClient(tenantId),
    store: new PgInTouchMirrorStore(),
    engine: engine(),
    systemUserId: null,
    log: (msg, detail) => console.warn(`[intouch] ${msg}`, detail instanceof Error ? detail.message : detail ?? ''),
  };
}

/**
 * Where this firm's InTouch sends webhooks — the admin pastes it into InTouch under
 * Settings > API > Webhooks. `firm` says whose; `key` proves it, since InTouch does not sign.
 */
export const inTouchWebhookUrl = (tenantId: string, key: string) =>
  `${config.appUrl}/api/v1/integrations/intouch/webhook?firm=${encodeURIComponent(tenantId)}&key=${encodeURIComponent(key)}`;
/** Where a firm manages the connection. */
export const inTouchSettingsPath = () => `${paths.leap.replace('/leap', '/intouch')}`;
