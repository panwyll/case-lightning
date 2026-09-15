/**
 * Addendum — internally-linked counterparties.
 *
 * A matter's counterparty solicitor is a RESOLVER, not a fixed data source: the
 * `CounterpartyRef` on the matter is either an external party or another internal
 * matter, and `resolveCounterparty()` turns both into the same `Counterparty` shape.
 * Nothing downstream (engine, comms, dashboard, drafting) branches on the kind — it
 * only ever sees a name, an email and a `type` to stamp on the audit trail.
 *
 * The wall itself lives in the database (migration 068: RLS + triggers); this module
 * gives the application the same rules up front (clear errors before the DB says no)
 * and the one sanctioned cross-wall read: the counterparty's CONTACT DETAILS, which
 * is exactly what an external firm's letterhead would tell you. It runs as the system
 * and returns nothing else about the other matter.
 */
import { query, queryOne, runAsSystem } from '../db';

export type CounterpartyRef = { kind: 'external'; name: string | null; email: string | null; firm: string | null } | { kind: 'internal'; matterId: string };

export type CounterpartyType = 'internal' | 'external';

export interface Counterparty {
  type: CounterpartyType;
  name: string | null;
  email: string | null;
  firm: string | null;
  /** Only for internal: the linked matter's id (for the audit link, never for reading its state). */
  matterId: string | null;
}

export class ConflictOfInterestError extends Error {
  status = 409;
  constructor(message: string) {
    super(message);
    this.name = 'ConflictOfInterestError';
  }
}

/** Requirement 5, pure: the same handler may never sit on both sides. */
export function assertNoSharedHandler(a: { matterId: string; handlerId: string | null }, b: { matterId: string; handlerId: string | null }): void {
  if (a.handlerId && b.handlerId && a.handlerId === b.handlerId) {
    throw new ConflictOfInterestError(`conflict of interest: handler ${a.handlerId} would act for both sides (matters ${a.matterId} and ${b.matterId}). Documented-consent exceptions are handled outside this system.`);
  }
}

export const isInternal = (ref: CounterpartyRef | null | undefined): ref is { kind: 'internal'; matterId: string } => ref?.kind === 'internal';

export function parseCounterpartyRef(raw: unknown): CounterpartyRef | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.kind === 'internal' && typeof r.matterId === 'string') return { kind: 'internal', matterId: r.matterId };
  if (r.kind === 'external') return { kind: 'external', name: (r.name as string) ?? null, email: (r.email as string) ?? null, firm: (r.firm as string) ?? null };
  return null;
}

/** The ref stored on a matter (null = not set; legacy free-text counterparty_solicitor is used as a fallback name). */
export async function counterpartyRefOf(tenantId: string, matterId: string): Promise<CounterpartyRef | null> {
  const m = await queryOne<{ counterparty_ref: unknown; counterparty_solicitor: string | null }>(`select counterparty_ref, counterparty_solicitor from matter where id = $1 and tenant_id = $2`, [matterId, tenantId]);
  if (!m) return null;
  return parseCounterpartyRef(m.counterparty_ref) ?? (m.counterparty_solicitor ? { kind: 'external', name: m.counterparty_solicitor, email: null, firm: m.counterparty_solicitor } : null);
}

/**
 * Resolve to contact details. For an internal link this reads ONLY the linked matter's
 * handler (name, email) as the system — the equivalent of knowing which firm and fee
 * earner is on the other side. It never returns the other matter's facts.
 */
export async function resolveCounterparty(tenantId: string, matterId: string): Promise<Counterparty | null> {
  const ref = await counterpartyRefOf(tenantId, matterId);
  if (!ref) return null;
  if (ref.kind === 'external') {
    // Prefer a tagged OTHER_SIDE contact for the email if the ref has none.
    const c = ref.email ? null : await queryOne<{ email: string; name: string | null }>(`select email, name from matter_contact where matter_id = $1 and tenant_id = $2 and role = 'OTHER_SIDE' order by last_seen_at desc limit 1`, [matterId, tenantId]).catch(() => null);
    return { type: 'external', name: ref.name ?? c?.name ?? null, email: ref.email ?? c?.email ?? null, firm: ref.firm, matterId: null };
  }
  return runAsSystem(async () => {
    const h = await queryOne<{ email: string; display_name: string | null; firm: string }>(
      `select u.email, u.display_name, t.name as firm
         from matter m join tenant t on t.id = m.tenant_id
         left join app_user u on u.id = coalesce(m.assigned_to, m.created_by)
        where m.id = $1 and m.tenant_id = $2`,
      [ref.matterId, tenantId]
    );
    if (!h) return null;
    return { type: 'internal', name: h.display_name ?? h.email, email: h.email, firm: h.firm, matterId: ref.matterId };
  });
}

export async function counterpartyTypeOf(tenantId: string, matterId: string): Promise<CounterpartyType | null> {
  const ref = await counterpartyRefOf(tenantId, matterId);
  return ref ? (ref.kind === 'internal' ? 'internal' : 'external') : null;
}

/**
 * Set a matter's counterparty. An internal link is written to BOTH matters and to
 * matter_link (whose trigger re-checks the shared-handler rule), after the application
 * check below has already rejected a conflict with a clear message.
 */
export async function setCounterparty(tenantId: string, matterId: string, ref: CounterpartyRef, actorUserId: string, chainRef?: string | null): Promise<void> {
  if (ref.kind === 'external') {
    await query(`update matter set counterparty_ref = $3::jsonb, counterparty_solicitor = coalesce($4, counterparty_solicitor), updated_at = now() where id = $1 and tenant_id = $2`, [matterId, tenantId, JSON.stringify(ref), ref.firm ?? ref.name]);
    return;
  }
  if (ref.matterId === matterId) throw new ConflictOfInterestError('A matter cannot be its own counterparty.');
  await runAsSystem(async () => {
    const rows = await query<{ id: string; assigned_to: string | null }>(`select id, assigned_to from matter where tenant_id = $1 and id = any($2::uuid[])`, [tenantId, [matterId, ref.matterId]]);
    const a = rows.find((r) => r.id === matterId);
    const b = rows.find((r) => r.id === ref.matterId);
    if (!a || !b) throw Object.assign(new Error('Linked matter not found in this firm.'), { status: 404 });
    assertNoSharedHandler({ matterId: a.id, handlerId: a.assigned_to }, { matterId: b.id, handlerId: b.assigned_to });
    const [lo, hi] = [a.id, b.id].sort();
    await query(`insert into matter_link (tenant_id, matter_a, matter_b, chain_ref, created_by) values ($1,$2,$3,$4,$5) on conflict (matter_a, matter_b) do update set chain_ref = coalesce(excluded.chain_ref, matter_link.chain_ref)`, [tenantId, lo, hi, chainRef ?? null, actorUserId]);
    await query(`update matter set counterparty_ref = $3::jsonb, updated_at = now() where id = $1 and tenant_id = $2`, [a.id, tenantId, JSON.stringify({ kind: 'internal', matterId: b.id })]);
    await query(`update matter set counterparty_ref = $3::jsonb, updated_at = now() where id = $1 and tenant_id = $2`, [b.id, tenantId, JSON.stringify({ kind: 'internal', matterId: a.id })]);
  });
}

/** Requirement 5 at reassignment time (the DB trigger is the backstop). */
export async function assertCanAssign(tenantId: string, matterId: string, handlerId: string | null): Promise<void> {
  if (!handlerId) return;
  const linked = await runAsSystem(() => query<{ h: string }>(`select h from engine_linked_handler($1) h`, [matterId]).catch(() => []));
  if (linked.some((r) => r.h === handlerId)) throw new ConflictOfInterestError(`conflict of interest: handler ${handlerId} already acts for the counterparty of matter ${matterId}.`);
}

/** Can this database role be walled at all? (BYPASSRLS / superuser roles skip RLS.) */
export async function wallEnforced(): Promise<boolean> {
  const r = await queryOne<{ bypass: boolean; su: boolean; policy: boolean }>(
    `select rolbypassrls as bypass, rolsuper as su, exists(select 1 from pg_policies where policyname = 'engine_wall' and tablename = 'matter') as policy from pg_roles where rolname = current_user`
  );
  return !!r && !r.bypass && !r.su && r.policy;
}
