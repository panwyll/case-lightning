/**
 * The firm's own case system (InTouch today; another CRM tomorrow): a case opened in CONVEYi is opened there too, so
 * the firm's system of record has every case and write-back has somewhere to go. One interface, one implementation per
 * system; the firm's connected and configured system is used, else nothing happens.
 *
 * Only a case a person opens in CONVEYi (New Case) is created there: a case that came from the system, or was found under
 * way in the mailbox, already exists. A failure is a task on the case ("Not created in <system>"), with Try Again,
 * never silent. Sandbox cases never reach a real system.
 */
import { query, queryOne, runAsSystem } from '../db';
import { engine } from '../engine/adapters';
import { SYSTEM } from '../engine/types';

/** What a new case is, in the terms any case system takes. */
export interface NewCase {
  matterId: string;
  reference: string;
  propertyAddress: string | null;
  postcode: string | null;
  side: 'purchase' | 'sale' | 'remortgage';
  clientNames: string[];
  clientEmail: string | null;
  feeEarnerName: string | null;
  feeEarnerEmail: string | null;
}

export interface CaseSystem {
  key: string;
  /** As the firm knows it ("InTouch"). */
  label: string;
  /** Connected, and set up to create cases (what it needs is filled in). */
  ready(tenantId: string): Promise<boolean>;
  /** Already linked to a case there. */
  linked(tenantId: string, matterId: string): Promise<boolean>;
  /** Create it there and link the two. Throws with a reason a person can act on. */
  create(tenantId: string, c: NewCase): Promise<{ externalId: string; link: string | null }>;
}

async function systems(): Promise<CaseSystem[]> {
  const { inTouchCaseSystem } = await import('./intouch/case-system');
  return [inTouchCaseSystem];
}

/** The system this firm creates its cases in, if one is connected and configured. */
export async function caseSystemFor(tenantId: string): Promise<CaseSystem | null> {
  for (const s of await systems()) if (await s.ready(tenantId).catch(() => false)) return s;
  return null;
}

async function newCaseOf(tenantId: string, matterId: string): Promise<NewCase | null> {
  const m = await runAsSystem(() => queryOne<{ matter_ref: string; property_address: string | null; address_parts: { postcode?: string } | null; track: string | null; buyer_names: string[] | null; seller_names: string[] | null; fe_name: string | null; fe_email: string | null; sandbox: boolean | null }>(
    `select m.matter_ref, m.property_address, m.address_parts, m.track, m.buyer_names, m.seller_names, m.sandbox, u.display_name as fe_name, u.email as fe_email
       from matter m left join app_user u on u.id = coalesce(m.assigned_to, m.created_by) where m.id = $1 and m.tenant_id = $2`, [matterId, tenantId]
  ));
  if (!m || m.sandbox) return null;
  const client = await runAsSystem(() => queryOne<{ email: string }>(`select email from matter_contact where matter_id = $1 and role = 'CLIENT' order by last_seen_at desc nulls last limit 1`, [matterId])).catch(() => null);
  const side = m.track === 'SALE' ? 'sale' : m.track === 'REMORTGAGE' ? 'remortgage' : 'purchase';
  return {
    matterId, reference: m.matter_ref, propertyAddress: m.property_address, postcode: m.address_parts?.postcode ?? m.property_address?.match(/[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\s*$/i)?.[0]?.toUpperCase() ?? null,
    side, clientNames: (side === 'sale' ? m.seller_names : m.buyer_names) ?? [], clientEmail: client?.email ?? null, feeEarnerName: m.fe_name, feeEarnerEmail: m.fe_email,
  };
}

/**
 * Open a new CONVEYi case in the firm's case system. `retry`: a person pressed Try Again, so a failure is thrown back to
 * them rather than raised as another task.
 */
export async function createInCaseSystem(tenantId: string, matterId: string, opts: { retry?: boolean } = {}): Promise<'created' | 'skipped'> {
  const system = await caseSystemFor(tenantId);
  if (!system) return 'skipped';
  const c = await newCaseOf(tenantId, matterId);
  if (!c || (await system.linked(tenantId, matterId))) return 'skipped';
  try {
    await system.create(tenantId, c);
    await runAsSystem(() => query(`insert into matter_timeline_event (tenant_id, matter_id, event_type, title, details, source_ref) values ($1,$2,'NOTE',$3,$4,$5::jsonb)`,
      [tenantId, matterId, `Case created in ${system.label}`, null, JSON.stringify({ source: system.key })])).catch(() => {});
    return 'created';
  } catch (err) {
    const reason = (err as Error)?.message ?? String(err);
    if (opts.retry) throw Object.assign(new Error(`${system.label} did not create the case: ${reason}`), { status: 502 });
    // A task on the case: what failed, what to do, and Try Again (engine retryIssue reads the marker).
    const detail = [`${system.label} did not create this case: ${reason}`, '', 'What to do:', `1. Check the case's details and the ${system.label} settings under Tools, then Try Again`, `2. Or open the case in ${system.label} yourself; it is linked at the next sync if its reference is ${c.reference}`, '', `[case-system:${system.key}]`].join('\n');
    await engine().run(tenantId, matterId, { type: 'raise_issue', actor: SYSTEM, kind: 'send_failed', title: `Case not created in ${system.label}`, detail, gate: 'none' }).catch(() => {});
    return 'skipped';
  }
}
