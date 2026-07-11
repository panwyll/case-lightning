/**
 * Firm-customisable pipeline stages (checkpoints). The 7 built-in keys are seeded so matters,
 * milestone drafts and matching keep working; firms rename them, reorder, add new ones, or
 * deactivate. `key` is stable (stored on matter.stage / task_template.stage); `name` is display.
 * Guarded/idempotent — callers fall back to the built-in list if not migrated.
 */
import { query, queryOne } from './db';
import type { SessionUser } from './types';

export interface StageRow { id: string; key: string; name: string; sort_order: number; active: boolean }

export const BUILTIN_STAGES: Array<{ key: string; name: string }> = [
  { key: 'INSTRUCTION', name: 'Instruction' },
  { key: 'CONTRACT_PACK', name: 'Contract pack' },
  { key: 'SEARCHES_ENQUIRIES', name: 'Searches & enquiries' },
  { key: 'REVIEW_SIGNING', name: 'Review & signing' },
  { key: 'EXCHANGE', name: 'Exchange' },
  { key: 'COMPLETION', name: 'Completion' },
  { key: 'POST_COMPLETION', name: 'Post-completion' },
];

export async function ensureDefaultStages(tenantId: string): Promise<void> {
  try {
    const t = await queryOne<{ stages_seeded: boolean }>(`select stages_seeded from tenant where id = $1`, [tenantId]).catch(() => null);
    if (t?.stages_seeded) return;
    const n = await queryOne<{ n: number }>(`select count(*)::int as n from matter_stage where tenant_id = $1`, [tenantId]).catch(() => ({ n: 0 }));
    if ((n?.n ?? 0) === 0) {
      let order = 0;
      for (const s of BUILTIN_STAGES) {
        await query(
          `insert into matter_stage (tenant_id, key, name, sort_order) values ($1,$2,$3,$4) on conflict (tenant_id, key) do nothing`,
          [tenantId, s.key, s.name, order++]
        ).catch(() => {});
      }
    }
    await query(`update tenant set stages_seeded = true where id = $1`, [tenantId]).catch(() => {});
  } catch {
    /* best-effort */
  }
}

export async function listStages(tenantId: string): Promise<StageRow[]> {
  try {
    const rows = await query<StageRow>(
      `select id, key, name, sort_order, active from matter_stage where tenant_id = $1 order by sort_order, name`,
      [tenantId]
    );
    if (rows.length) return rows;
  } catch {
    /* not migrated */
  }
  // Fallback so the pipeline still works before migration 042 / seeding.
  return BUILTIN_STAGES.map((s, i) => ({ id: s.key, key: s.key, name: s.name, sort_order: i, active: true }));
}

/** The set of valid stage keys for a tenant (used to validate matter.stage writes). */
export async function stageKeys(tenantId: string): Promise<string[]> {
  return (await listStages(tenantId)).map((s) => s.key);
}

const slugKey = (name: string) => name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'STAGE';

export async function saveStage(
  user: SessionUser,
  input: { id?: string | null; name: string; sortOrder?: number; active?: boolean }
): Promise<StageRow> {
  if (input.id) {
    const row = await queryOne<StageRow>(
      `update matter_stage set name=$2, sort_order=$3, active=$4 where id=$1 and tenant_id=$5
       returning id, key, name, sort_order, active`,
      [input.id, input.name.trim(), input.sortOrder ?? 0, input.active ?? true, user.tenantId]
    );
    return row!;
  }
  // New stage: derive a stable, unique key from the name.
  let key = slugKey(input.name);
  const existing = new Set((await listStages(user.tenantId)).map((s) => s.key));
  if (existing.has(key)) { let i = 2; while (existing.has(`${key}_${i}`)) i++; key = `${key}_${i}`; }
  const row = await queryOne<StageRow>(
    `insert into matter_stage (tenant_id, key, name, sort_order, active) values ($1,$2,$3,$4,true)
     returning id, key, name, sort_order, active`,
    [user.tenantId, key, input.name.trim(), input.sortOrder ?? 99]
  );
  return row!;
}

export async function saveStageOrder(user: SessionUser, order: Array<{ id: string; sortOrder: number }>): Promise<void> {
  for (const o of order) {
    await query(`update matter_stage set sort_order=$2 where id=$1 and tenant_id=$3`, [o.id, o.sortOrder, user.tenantId]).catch(() => {});
  }
}

export async function deleteStage(user: SessionUser, id: string): Promise<void> {
  // Don't orphan matters/templates: deactivate rather than hard-delete if it's in use.
  const s = await queryOne<{ key: string }>(`select key from matter_stage where id = $1 and tenant_id = $2`, [id, user.tenantId]);
  if (!s) return;
  const inUse = await queryOne<{ n: number }>(
    `select (select count(*) from matter where tenant_id=$1 and stage=$2) + (select count(*) from task_template where tenant_id=$1 and stage=$2) as n`,
    [user.tenantId, s.key]
  ).catch(() => ({ n: 1 }));
  if ((inUse?.n ?? 0) > 0) {
    await query(`update matter_stage set active=false where id=$1 and tenant_id=$2`, [id, user.tenantId]);
  } else {
    await query(`delete from matter_stage where id=$1 and tenant_id=$2`, [id, user.tenantId]);
  }
}
