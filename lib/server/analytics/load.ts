/**
 * Loads a firm's cases for analytics (kpis.ts): only the fields the figures need, read from the stored
 * engine state in SQL (a decision's summary or a wait's history never leaves the database), for every
 * case instructed in the last 25 months or still open. Sandbox cases are left out.
 */
import { query } from '../db';
import { getPolicy } from '../policy';
import { DEFAULT_SLA } from '../engine/sla';
import type { AnalyticsInput, CaseFacts, CaseSide, Party } from './kpis';
import { feeFor, parsePrice } from './fees';

const ROLE_PARTY: Record<string, Party> = { client: 'client', seller_solicitor: 'other_side', estate_agent: 'other_side', lender: 'lender', search_provider: 'searches', hmlr: 'land_registry' };
export function partyOf(key: string, subject: string | null): Party {
  if (key === 'funds') return subject && subject !== 'lender' ? 'client' : 'lender';
  if (['id_check', 'proof_of_funds', 'property_forms', 'signed_documents', 'deposit', 'client_decision', 'insurance', 'mortgage_offer', 'survey'].includes(key)) return 'client';
  return ROLE_PARTY[(DEFAULT_SLA as Record<string, { recipientRole?: string }>)[key]?.recipientRole ?? ''] ?? 'other';
}
export function sideOf(transactionType: string | null): CaseSide {
  const t = transactionType ?? '';
  if (t.endsWith('_purchase')) return 'purchase';
  if (t.endsWith('_sale')) return 'sale';
  if (t.includes('remortgage')) return 'remortgage';
  if (t.includes('transfer')) return 'transfer';
  return t ? 'other' : 'purchase';
}

type Row = {
  id: string; ref: string; handler_id: string | null; created_at: Date; purchase_price: string | null; transaction_type: string | null; instructed_at: string | null;
  exchanged_at: string | null; completed_at: string | null; abandoned_at: string | null; abandoned_reason: string | null; completion_date: string | null; has_lender: boolean; shapes: string[]; co_checks: number; donors: number;
  waits: Array<{ key: string; subject: string | null; openedAt: string; closedAt: string | null; chasesSentAt: string[] | null }> | null;
  decisions: Array<{ kind: string; createdAt: string; resolvedAt: string | null; resolvedBy: string | null }> | null;
};

export async function loadAnalyticsInput(tenantId: string, now = new Date()): Promise<AnalyticsInput> {
  const rows = await query<Row>(
    `select m.id, m.matter_ref as ref, coalesce(m.assigned_to, m.created_by) as handler_id, m.created_at, m.purchase_price,
            coalesce(s.state->>'transactionType', m.transaction_type) as transaction_type,
            s.state->'stageHistory'->0->>'at' as instructed_at,
            s.state->'exchange'->>'exchangedAt' as exchanged_at,
            s.state->'completion'->>'confirmedAt' as completed_at,
            s.state->'abandoned'->>'at' as abandoned_at,
            s.state->'abandoned'->>'reason' as abandoned_reason,
            s.state->'exchange'->>'completionDate' as completion_date,
            coalesce((s.state->>'hasLender')::boolean, false) as has_lender,
            coalesce(s.state->'shapes', '[]'::jsonb) as shapes,
            (select count(*) from jsonb_each(coalesce(s.state->'partyChecks', '{}'::jsonb)) p(k, v) where v->>'role' <> 'donor')::int as co_checks,
            (select count(*) from jsonb_each(coalesce(s.state->'partyChecks', '{}'::jsonb)) p(k, v) where v->>'role' = 'donor')::int as donors,
            (select jsonb_agg(jsonb_build_object('key', w->>'key', 'subject', w->>'subject', 'openedAt', w->>'openedAt', 'closedAt', w->>'closedAt', 'chasesSentAt', w->'chasesSentAt'))
               from jsonb_array_elements(coalesce(s.state->'waits', '[]'::jsonb)) w) as waits,
            (select jsonb_agg(jsonb_build_object('kind', d->>'kind', 'createdAt', d->>'createdAt', 'resolvedAt', d->>'resolvedAt', 'resolvedBy', d->>'resolvedBy'))
               from jsonb_each(coalesce(s.state->'decisions', '{}'::jsonb)) e(k, d)) as decisions
       from matter m
       join matter_engine_state s on s.matter_id = m.id
      where m.tenant_id = $1 and coalesce(m.sandbox, false) = false and m.merged_into is null
        and (m.created_at > now() - interval '25 months' or s.finished_at is null)`,
    [tenantId]
  );
  const scale = await getPolicy(tenantId, 'feeScale');
  const cases: CaseFacts[] = rows.map((r) => ({
    id: r.id,
    ref: r.ref,
    handlerId: r.handler_id,
    side: sideOf(r.transaction_type),
    leasehold: (r.transaction_type ?? '').startsWith('leasehold'),
    instructedAt: r.instructed_at ?? r.created_at.toISOString(),
    exchangedAt: r.exchanged_at,
    completedAt: r.completed_at,
    abandoned: r.abandoned_at ? { at: r.abandoned_at, reason: r.abandoned_reason ?? 'other' } : null,
    completionDate: r.completion_date,
    // Every client is ID checked, and each named party (a co-buyer, an attorney) and each gift donor too.
    fee: feeFor(scale, { side: sideOf(r.transaction_type), price: parsePrice(r.purchase_price), leasehold: (r.transaction_type ?? '').startsWith('leasehold'), hasLender: r.has_lender, idChecks: 1 + r.co_checks + r.donors, gifts: r.donors, shapes: r.shapes ?? [] }),
    waits: (r.waits ?? []).filter((w) => w.openedAt).map((w) => ({ key: w.key, party: partyOf(w.key, w.subject), openedAt: w.openedAt, closedAt: w.closedAt, chases: w.chasesSentAt ?? [] })),
    decisions: (r.decisions ?? []).filter((d) => d.createdAt).map((d) => ({ kind: d.kind, createdAt: d.createdAt, resolvedAt: d.resolvedAt, resolvedBy: d.resolvedBy })),
  }));
  const feedback = await query<{ matter_id: string; handler_id: string | null; kind: 'csat' | 'nps'; score: number; comment: string | null; created_at: Date }>(
    `select matter_id, handler_id, kind, score, comment, created_at from client_feedback where tenant_id = $1 and created_at > now() - interval '25 months'`,
    [tenantId]
  ).catch(() => []);
  const people = await query<{ id: string; name: string }>(`select id, coalesce(nullif(display_name, ''), email) as name from app_user where tenant_id = $1`, [tenantId]);
  const targets = await getPolicy(tenantId, 'analyticsTargets');
  return {
    now,
    cases,
    feedback: feedback.map((f) => ({ matterId: f.matter_id, handlerId: f.handler_id, kind: f.kind, score: f.score, comment: f.comment, at: f.created_at.toISOString() })),
    targets: targets ?? { monthlyCompletions: null, perPerson: {} },
    people,
  };
}
