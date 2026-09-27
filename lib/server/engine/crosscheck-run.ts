/**
 * Runs the cross-checks for a matter after every document read: gathers the case record
 * and the fact register, compares them, keeps the verdicts on matter_crosscheck, and
 * raises one "documents disagree" issue per mismatching check (resolving it when the
 * documents agree again). Best-effort and idempotent; a failure here never fails a read.
 */
import { query, queryOne } from '../db';
import { crossCheck, parsePennies, type CaseRecord, type CheckResult, type RegisterRow } from './crosscheck';
import { SYSTEM } from './types';

const ISSUE_TAG = (check: string) => `[crosscheck:${check}]`;

export async function loadCaseRecord(tenantId: string, matterId: string): Promise<CaseRecord | null> {
  const m = await queryOne<{ property_address: string | null; purchase_price: string | null; buyer_names: string[] | null; seller_names: string[] | null; lender: string | null; completion_target_date: string | null }>(
    `select property_address, purchase_price::text, buyer_names, seller_names, lender, completion_target_date::text from matter where id = $1 and tenant_id = $2`,
    [matterId, tenantId]
  );
  if (!m) return null;
  return { propertyAddress: m.property_address, purchasePricePennies: m.purchase_price ? parsePennies(m.purchase_price) : null, buyerNames: m.buyer_names ?? [], sellerNames: m.seller_names ?? [], lender: m.lender, completionDate: null };
}

export async function loadRegister(tenantId: string, matterId: string): Promise<RegisterRow[]> {
  const rows = await query<{ document_id: string; key: string; value: string; page: number | null; file_name: string | null; doc_type: string | null }>(
    `select f.document_id, f.key, f.value, f.page, d.file_name, d.doc_type from document_fact f join document d on d.id = f.document_id where f.tenant_id = $1 and f.matter_id = $2 and d.superseded_at is null`,
    [tenantId, matterId]
  );
  return rows.map((r) => ({ documentId: r.document_id, documentLabel: r.file_name ?? r.doc_type ?? r.document_id.slice(0, 8), key: r.key, value: r.value, page: r.page }));
}

export async function runCrossChecks(tenantId: string, matterId: string): Promise<CheckResult[]> {
  const record = await loadCaseRecord(tenantId, matterId);
  if (!record) return [];
  const { engine } = await import('./adapters');
  const svc = engine();
  const state = await svc.getState(tenantId, matterId).catch(() => null);
  if (state?.exchange.completionDate) record.completionDate = state.exchange.completionDate;
  if (state?.nameAliases?.length) record.nameAliases = state.nameAliases.map((a) => ({ from: a.from, to: a.to }));
  const results = crossCheck(record, await loadRegister(tenantId, matterId));
  for (const r of results) {
    await query(
      `insert into matter_crosscheck (tenant_id, matter_id, "check", status, detail, updated_at) values ($1, $2, $3, $4, $5::jsonb, now())
       on conflict (tenant_id, matter_id, "check") do update set status = excluded.status, detail = excluded.detail, updated_at = now()`,
      [tenantId, matterId, r.check, r.status, JSON.stringify({ label: r.label, message: r.message, values: r.values })]
    ).catch(() => {});
  }
  if (!state?.enrolled) return results;
  // One issue per mismatching check, tagged so it can be found again; closed when the documents agree.
  const open = Object.values(state.issues).filter((i) => i.kind === 'document_mismatch' && (i.status === 'open' || i.status === 'negotiating'));
  for (const r of results) {
    const existing = open.find((i) => i.title.includes(ISSUE_TAG(r.check)));
    if (r.status === 'mismatch' && !existing) {
      await svc.run(tenantId, matterId, { type: 'raise_issue', actor: SYSTEM, kind: 'document_mismatch', title: `${r.label} differs between documents ${ISSUE_TAG(r.check)}`, detail: `${r.message}\n${r.values.map((v) => `${v.source}${v.page ? ` p.${v.page}` : ''}: ${v.value}`).join('\n')}`, gate: 'exchange', severity: 'warning' }).catch(() => {});
    } else if (r.status === 'match' && existing) {
      await svc.run(tenantId, matterId, { type: 'resolve_issue', actor: SYSTEM, issueId: existing.id, resolution: 'other', note: `${r.label} now agrees across ${r.values.length} sources (cross-check).` }).catch(() => {});
    }
  }
  return results;
}

export async function loadCrossChecks(tenantId: string, matterId: string): Promise<CheckResult[]> {
  const rows = await query<{ check: string; status: string; detail: { label: string; message: string; values: CheckResult['values'] } }>(`select "check", status, detail from matter_crosscheck where tenant_id = $1 and matter_id = $2 order by status desc, "check"`, [tenantId, matterId]).catch(() => []);
  return rows.map((r) => ({ check: r.check as CheckResult['check'], status: r.status as CheckResult['status'], label: r.detail.label, message: r.detail.message, values: r.detail.values ?? [] }));
}
