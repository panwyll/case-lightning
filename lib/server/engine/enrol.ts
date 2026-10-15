import { query, queryOne, runAsSystem } from '../db';
import { engine } from './adapters';
import { counterpartyTypeOf } from './counterparty';
import { SYSTEM, type TransactionType } from './types';

/**
 * Every open matter is tracked. A case starts here or in the CRM and is on the engine from
 * that moment; nothing sits on the caseload untracked. These two calls are what make that
 * true: one for a matter as it is created, one sweep for the ones that came before.
 */
function transactionTypeOf(track: string | null): TransactionType {
  return track === 'SALE' ? 'freehold_sale' : track === 'REMORTGAGE' ? 'remortgage' : 'freehold_purchase';
}

/** Our clients on the matter record: the sellers on a sale, otherwise the buyers (the owners on a remortgage). */
export function clientNamesOf(track: string | null, buyers: string[] | null, sellers: string[] | null): string[] {
  return [...new Set(((track === 'SALE' ? sellers : buyers) ?? []).map((n) => n.trim()).filter(Boolean))];
}

/** Enrol one matter if it is open and not yet on the engine. Returns true when it enrolled it. */
/** `funding`: what the New Case form said; otherwise a lender on the matter means a mortgage (a purchase) or one to pay off (a sale or remortgage). */
/** `placing`: the case was taken on part-way through (why, in a few words): it is placed from its history before anything is sent. */
export async function enrolIfUntracked(tenantId: string, matterId: string, actor: string = SYSTEM, funding: { hasLender?: boolean; hasExistingMortgage?: boolean; placing?: string | null } = {}): Promise<boolean> {
  const m = await runAsSystem(() =>
    queryOne<{ status: string | null; track: string | null; lender: string | null; exchange_target_date: string | null; completion_target_date: string | null; enrolled: string | null; buyer_names: string[] | null; seller_names: string[] | null }>(
      `select m.status, m.track, m.lender, m.buyer_names, m.seller_names, m.exchange_target_date::text, m.completion_target_date::text, s.state->>'enrolled' as enrolled
         from matter m left join matter_engine_state s on s.matter_id = m.id
        where m.id = $1 and m.tenant_id = $2`,
      [matterId, tenantId]
    )
  );
  if (!m || (m.status ?? 'OPEN') === 'CLOSED' || m.enrolled === 'true') return false;
  const counterpartyType = await runAsSystem(() => counterpartyTypeOf(tenantId, matterId)).catch(() => null);
  // As the system: the person sweeping the caseload may be walled off from a matter on the
  // other side of a chain, and that matter is tracked all the same.
  await runAsSystem(() => engine().run(tenantId, matterId, {
    type: 'enrol',
    actor,
    transactionType: transactionTypeOf(m.track),
    hasLender: funding.hasLender ?? (m.track === 'SALE' ? false : !!m.lender),
    hasExistingMortgage: funding.hasExistingMortgage ?? (m.track === 'SALE' ? !!m.lender : m.track === 'REMORTGAGE'),
    targetExchangeDate: m.exchange_target_date,
    targetCompletionDate: m.completion_target_date,
    counterpartyType,
    shadowMode: false,
    // Our clients by name: the rules that ask "is this our client?" read them.
    partyNames: clientNamesOf(m.track, m.buyer_names, m.seller_names),
    parties: Math.max(1, clientNamesOf(m.track, m.buyer_names, m.seller_names).length),
    placing: funding.placing ?? null,
  }));
  return true;
}

/**
 * A case placed from its history: every document already filed on it is read again, oldest first, through the same
 * ingest as a new one (searches, offers, forms, the title...), so the case lands where its evidence says. Nothing is
 * sent while it is placing. Bounded; email bodies are read as documents only (their notes are not raised again).
 */
export async function replayFiled(tenantId: string, matterId: string, limit = 300): Promise<number> {
  const docs = await runAsSystem(() => query<{ id: string }>(
    `select id from document where tenant_id = $1 and matter_id = $2 and superseded_at is null and coalesce(doc_type, '') not in ('PROPOSAL', 'SANDBOX_EMAIL') and coalesce(doc_type, '') not like '%DRAFT%'
      order by created_at asc limit $3`, [tenantId, matterId, limit]
  )).catch(() => []);
  const { ingestFiledDocument } = await import('./ingest-hook');
  let n = 0;
  for (const d of docs) { if (await ingestFiledDocument(tenantId, matterId, d.id).catch(() => null)) n++; }
  return n;
}

/** Enrol every open matter in the firm that is not yet tracked. Returns how many it enrolled. */
export async function enrolAllOpen(tenantId: string, actor: string = SYSTEM): Promise<{ enrolled: number; failed: number }> {
  const rows = await runAsSystem(() =>
    query<{ id: string }>(
      `select m.id from matter m left join matter_engine_state s on s.matter_id = m.id
        where m.tenant_id = $1 and coalesce(m.status, 'OPEN') <> 'CLOSED'
          and (s.matter_id is null or s.state->>'enrolled' is distinct from 'true')
        order by m.created_at asc limit 1000`,
      [tenantId]
    )
  );
  let enrolled = 0; let failed = 0;
  for (const r of rows) {
    try {
      // A case with documents already on it was taken on part-way through: placed from them.
      const has = await runAsSystem(() => queryOne<{ n: number }>(`select count(*)::int as n from document where tenant_id = $1 and matter_id = $2 and coalesce(doc_type, '') not in ('PROPOSAL', 'SANDBOX_EMAIL')`, [tenantId, r.id])).catch(() => null);
      const placing = (has?.n ?? 0) > 0 ? 'Enrolled with documents already on file' : null;
      if (await enrolIfUntracked(tenantId, r.id, actor, { placing })) { enrolled++; if (placing) await replayFiled(tenantId, r.id); }
    } catch { failed++; }
  }
  return { enrolled, failed };
}
