/** Open banking connections (migration 118) and the documents made from the accounts shared. */
import crypto from 'node:crypto';
import { query, queryOne } from '../db';
import type { ConnectedAccount } from './provider';

export interface ConnectionRow { id: string; tenant_id: string; matter_id: string; request_id: string; source_index: number; party: 'client' | 'donor'; provider: string; institution_id: string; institution_name: string; provider_ref: string | null; status: 'started' | 'linked' | 'failed' | 'expired'; error: string | null; document_ids: string[] }

export async function createConnection(c: { tenantId: string; matterId: string; requestId: string; sourceIndex: number; party: 'client' | 'donor'; provider: string; institutionId: string; institutionName: string }): Promise<string> {
  const r = await queryOne<{ id: string }>(`insert into open_banking_connection (tenant_id, matter_id, request_id, source_index, party, provider, institution_id, institution_name) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`, [c.tenantId, c.matterId, c.requestId, c.sourceIndex, c.party, c.provider, c.institutionId, c.institutionName]);
  return r!.id;
}
export async function setProviderRef(id: string, ref: string): Promise<void> { await query(`update open_banking_connection set provider_ref = $2 where id = $1`, [id, ref]); }
export async function getConnection(id: string): Promise<ConnectionRow | null> { return queryOne<ConnectionRow>(`select * from open_banking_connection where id = $1`, [id]); }
export async function finishConnection(id: string, status: ConnectionRow['status'], documentIds: string[], error: string | null = null): Promise<void> {
  await query(`update open_banking_connection set status = $2, document_ids = $3::uuid[], error = $4, linked_at = case when $2 = 'linked' then now() else linked_at end where id = $1`, [id, status, documentIds, error]);
}
export async function connectionsFor(requestId: string): Promise<Array<ConnectionRow & { files: Array<{ id: string; fileName: string }> }>> {
  const rows = await query<ConnectionRow>(`select * from open_banking_connection where request_id = $1 order by created_at`, [requestId]);
  const ids = rows.flatMap((r) => r.document_ids);
  const names = ids.length ? await query<{ id: string; file_name: string }>(`select id, file_name from document where id = any($1::uuid[])`, [ids]) : [];
  return rows.map((r) => ({ ...r, files: r.document_ids.map((id) => ({ id, fileName: names.find((n) => n.id === id)?.file_name ?? 'Connected account' })) }));
}

/** One shared account as a document on the case, tagged to the form (like an upload) so the submission accepts it. */
export async function saveAccountDocument(c: ConnectionRow, a: ConnectedAccount, provider: string): Promise<string> {
  const facts = { statement: a.statement, openBanking: { provider, institutionId: c.institution_id, institutionName: c.institution_name, connectionId: c.id, accountId: a.providerAccountId, currency: a.currency, fetchedAt: new Date().toISOString() } };
  const json = JSON.stringify(facts);
  const months = a.statement.periodFrom && a.statement.periodTo ? Math.max(1, Math.round((Date.parse(a.statement.periodTo) - Date.parse(a.statement.periodFrom)) / (30.4 * 86_400_000))) : 0;
  const fileName = `${a.bankName}${a.last4 ? ` ····${a.last4}` : ''} (connected, ${months} months)`;
  const row = await queryOne<{ id: string }>(
    `insert into document (tenant_id, matter_id, source_type, storage_path, file_name, mime_type, size_bytes, hash_sha256, doc_type, extracted_facts)
     values ($1,$2,'OPEN_BANKING',$3,$4,'application/json',$5,$6,'OPEN_BANKING_ACCOUNT',$7::jsonb) returning id`,
    [c.tenant_id, c.matter_id, `pof://${c.request_id}/ob/${c.id}/${a.providerAccountId}`, fileName, json.length, crypto.createHash('sha256').update(json).digest('hex'), json]
  );
  return row!.id;
}
