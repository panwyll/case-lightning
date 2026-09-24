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

/** Enrol one matter if it is open and not yet on the engine. Returns true when it enrolled it. */
export async function enrolIfUntracked(tenantId: string, matterId: string, actor: string = SYSTEM): Promise<boolean> {
  const m = await runAsSystem(() =>
    queryOne<{ status: string | null; track: string | null; lender: string | null; exchange_target_date: string | null; completion_target_date: string | null; enrolled: string | null }>(
      `select m.status, m.track, m.lender, m.exchange_target_date::text, m.completion_target_date::text, s.state->>'enrolled' as enrolled
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
    hasLender: !!m.lender,
    targetExchangeDate: m.exchange_target_date,
    targetCompletionDate: m.completion_target_date,
    counterpartyType,
    shadowMode: false,
  }));
  return true;
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
    try { if (await enrolIfUntracked(tenantId, r.id, actor)) enrolled++; } catch { failed++; }
  }
  return { enrolled, failed };
}
