/**
 * The firm's lender directory: what each lender's Part 2 says that changes a rule here.
 * Matched to a mortgage offer by name (loosely: "Nationwide Building Society" finds "Nationwide"),
 * and recorded on the matter as `lender_requirements_recorded`, so the rules that read
 * `state.lenderRequirements` (lease term, search age, gifts) run without anyone typing them again.
 */
import { query, queryOne } from '../db';

export interface LenderProfile {
  id: string;
  lenderName: string;
  minUnexpiredYears: number | null;
  maxSearchAgeMonths: number | null;
  acceptsNonFamilyGift: boolean | null;
  requiresEws1: boolean | null;
  note: string | null;
  updatedAt: string;
}
export interface LenderDirectory {
  find(tenantId: string, lenderName: string): Promise<LenderProfile | null>;
}

const norm = (s: string): string => s.toLowerCase().replace(/\b(plc|ltd|limited|bank|building society|bs|uk|the)\b/g, ' ').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

const row = (r: { id: string; lender_name: string; min_unexpired_years: number | null; max_search_age_months: number | null; accepts_non_family_gift: boolean | null; requires_ews1: boolean | null; note: string | null; updated_at: string }): LenderProfile => ({ id: r.id, lenderName: r.lender_name, minUnexpiredYears: r.min_unexpired_years, maxSearchAgeMonths: r.max_search_age_months, acceptsNonFamilyGift: r.accepts_non_family_gift, requiresEws1: r.requires_ews1, note: r.note, updatedAt: r.updated_at });
type Row = Parameters<typeof row>[0];

export async function listLenders(tenantId: string): Promise<LenderProfile[]> {
  const rows = await query<Row>(`select id, lender_name, min_unexpired_years, max_search_age_months, accepts_non_family_gift, requires_ews1, note, updated_at::text from lender_profile where tenant_id = $1 order by lower(lender_name)`, [tenantId]);
  return rows.map(row);
}

export async function upsertLender(tenantId: string, userId: string, p: Omit<LenderProfile, 'id' | 'updatedAt'>): Promise<LenderProfile> {
  const r = await queryOne<Row>(
    `insert into lender_profile (tenant_id, lender_name, min_unexpired_years, max_search_age_months, accepts_non_family_gift, requires_ews1, note, updated_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (tenant_id, lower(lender_name)) do update set lender_name = excluded.lender_name, min_unexpired_years = excluded.min_unexpired_years, max_search_age_months = excluded.max_search_age_months, accepts_non_family_gift = excluded.accepts_non_family_gift, requires_ews1 = excluded.requires_ews1, note = excluded.note, updated_by = excluded.updated_by, updated_at = now()
     returning id, lender_name, min_unexpired_years, max_search_age_months, accepts_non_family_gift, requires_ews1, note, updated_at::text`,
    [tenantId, p.lenderName.trim(), p.minUnexpiredYears, p.maxSearchAgeMonths, p.acceptsNonFamilyGift, p.requiresEws1, p.note, userId]
  );
  return row(r!);
}

export async function deleteLender(tenantId: string, id: string): Promise<void> {
  await query(`delete from lender_profile where tenant_id = $1 and id = $2`, [tenantId, id]);
}

/** The production directory: a lender named on an offer against the firm's list, exact first, then by the distinctive words. */
export class PgLenderDirectory implements LenderDirectory {
  async find(tenantId: string, lenderName: string): Promise<LenderProfile | null> {
    const want = norm(lenderName);
    if (!want) return null;
    const all = await listLenders(tenantId);
    return all.find((l) => norm(l.lenderName) === want) ?? all.find((l) => { const n = norm(l.lenderName); return n.length > 3 && (want.includes(n) || n.includes(want)); }) ?? null;
  }
}
