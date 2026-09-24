/**
 * The production wiring for InTouch: Postgres-backed token store and mirror store, the
 * client, and the small helpers the API routes use.
 *
 * Everything here runs as the automation role with no user bound (runAsSystem): a sync or
 * a webhook has no signed-in person behind it, and the database's own enforcement means
 * nothing arriving from InTouch can write a payment or a send event however it is shaped.
 */
import { query, queryOne, runAsSystem } from '../../db';
import { encryptSecret, decryptSecret } from '../../crypto';
import { config } from '../../config';
import { paths } from '../../../paths';
import { engine } from '../../engine/adapters';
import { InTouchHttpClient, type InTouchApi, type InTouchClientConfig, type InTouchTokenStore } from './client';
import type { InTouchCase, InTouchConnectionRow, InTouchDocument, InTouchParty, InTouchSyncSummary, InTouchTokens } from './types';
import type { InTouchMirrorRef, InTouchMirrorStore, InTouchSyncDeps } from './sync';
import { enrolIfUntracked } from '../../engine/enrol';

export function inTouchConfigured(): boolean {
  return !!(config.intouchApiBaseUrl && config.intouchClientId && config.intouchClientSecret);
}

export function inTouchClientConfig(): InTouchClientConfig {
  return {
    apiBaseUrl: config.intouchApiBaseUrl!,
    authBaseUrl: config.intouchAuthBaseUrl ?? null,
    clientId: config.intouchClientId!,
    clientSecret: config.intouchClientSecret!,
    apiKey: config.intouchApiKey ?? null,
    redirectUri: config.intouchRedirectUri,
    webhookSecret: config.intouchWebhookSecret ?? null,
    grant: config.intouchGrant,
  };
}

export class PgInTouchTokenStore implements InTouchTokenStore {
  async load(tenantId: string): Promise<InTouchTokens | null> {
    const r = await runAsSystem(() => queryOne<{ tokens_enc: string | null; status: string }>(`select tokens_enc, status from intouch_connection where tenant_id = $1`, [tenantId]));
    if (!r?.tokens_enc || r.status === 'DISCONNECTED') return null;
    return JSON.parse(decryptSecret(r.tokens_enc)) as InTouchTokens;
  }
  async save(tenantId: string, tokens: InTouchTokens): Promise<void> {
    await runAsSystem(() =>
      query(
        `insert into intouch_connection (tenant_id, tokens_enc, status, status_detail, updated_at) values ($1,$2,'CONNECTED',null,now())
         on conflict (tenant_id) do update set tokens_enc = excluded.tokens_enc, status = 'CONNECTED', status_detail = null, updated_at = now()`,
        [tenantId, encryptSecret(JSON.stringify(tokens))]
      )
    );
  }
  async markDisconnected(tenantId: string, reason: string): Promise<void> {
    await runAsSystem(() => query(`update intouch_connection set status = 'DISCONNECTED', status_detail = $2, updated_at = now() where tenant_id = $1`, [tenantId, reason]));
  }
}

export function inTouchClient(tenantId: string): InTouchApi & InTouchHttpClient {
  return new InTouchHttpClient(inTouchClientConfig(), tenantId, new PgInTouchTokenStore());
}

export async function inTouchConnection(tenantId: string): Promise<InTouchConnectionRow | null> {
  const r = await queryOne<{ tenant_id: string; account_id: string | null; account_name: string | null; status: InTouchConnectionRow['status']; status_detail: string | null; webhook_sub_id: string | null; last_sync_at: Date | null; last_sync_detail: InTouchSyncSummary | null; connected_at: Date | null; milestones_enabled: boolean }>(
    `select tenant_id, account_id, account_name, status, status_detail, webhook_sub_id, last_sync_at, last_sync_detail, connected_at, milestones_enabled from intouch_connection where tenant_id = $1`,
    [tenantId]
  );
  return r
    ? {
        tenantId: r.tenant_id,
        accountId: r.account_id,
        accountName: r.account_name,
        status: r.status,
        statusDetail: r.status_detail,
        webhookSubId: r.webhook_sub_id,
        lastSyncAt: r.last_sync_at?.toISOString() ?? null,
        lastSyncDetail: r.last_sync_detail,
        connectedAt: r.connected_at?.toISOString() ?? null,
        milestonesEnabled: r.milestones_enabled,
      }
    : null;
}

export async function setInTouchConnectionMeta(tenantId: string, meta: { accountId?: string | null; accountName?: string | null; webhookSubId?: string | null; connectedBy?: string | null; milestonesEnabled?: boolean }): Promise<void> {
  await runAsSystem(() =>
    query(
      `update intouch_connection set account_id = coalesce($2, account_id), account_name = coalesce($3, account_name), webhook_sub_id = coalesce($4, webhook_sub_id),
              connected_by = coalesce($5, connected_by), milestones_enabled = coalesce($6, milestones_enabled),
              connected_at = coalesce(connected_at, now()), updated_at = now()
        where tenant_id = $1`,
      [tenantId, meta.accountId ?? null, meta.accountName ?? null, meta.webhookSubId ?? null, meta.connectedBy ?? null, meta.milestonesEnabled ?? null]
    )
  );
}

export async function disconnectInTouch(tenantId: string): Promise<void> {
  await runAsSystem(() => query(`update intouch_connection set tokens_enc = null, status = 'DISCONNECTED', status_detail = 'Disconnected by the firm', milestones_enabled = false, updated_at = now() where tenant_id = $1`, [tenantId]));
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

export class PgInTouchMirrorStore implements InTouchMirrorStore {
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

  async upsertContacts(tenantId: string, matterId: string, parties: InTouchParty[]): Promise<void> {
    await runAsSystem(async () => {
      for (const p of parties) {
        // matter_contact is keyed on email; a party without one gets a stable placeholder
        // rather than being dropped.
        const email = p.email ?? `${p.id}@intouch.party`;
        await query(
          `insert into matter_contact (tenant_id, matter_id, email, name, role, source, phone, intouch_party_id, last_seen_at)
           values ($1,$2,$3,$4,$5,'INTOUCH',$6,$7,now())
           on conflict (matter_id, email) do update set name = coalesce(excluded.name, matter_contact.name), role = excluded.role,
                 phone = coalesce(excluded.phone, matter_contact.phone), intouch_party_id = excluded.intouch_party_id, last_seen_at = now()`,
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
        await query(`insert into document_blob (document_id, bytes) values ($1,$2) on conflict (document_id) do nothing`, [r!.id, bytes]);
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
export function inTouchSyncDeps(tenantId: string): InTouchSyncDeps {
  return {
    api: inTouchClient(tenantId),
    store: new PgInTouchMirrorStore(),
    engine: engine(),
    systemUserId: null,
    log: (msg, detail) => console.warn(`[intouch] ${msg}`, detail instanceof Error ? detail.message : detail ?? ''),
  };
}

/** Where InTouch sends us webhooks, and where a firm manages the connection. */
export const inTouchWebhookUrl = () => `${config.appUrl}/api/v1/integrations/intouch/webhook`;
export const inTouchSettingsPath = () => `${paths.leap.replace('/leap', '/intouch')}`;
