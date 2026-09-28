import { NextRequest } from 'next/server';
import { allPolicies, setPolicy, POLICY_DEFAULTS, type PolicyKey } from '@/lib/server/policy';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireRole } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { query } from '@/lib/server/db';
import { engine } from '@/lib/server/engine/adapters';
import { writeAudit } from '@/lib/server/audit';
import { DEFAULT_SLA } from '@/lib/server/engine/sla';
import { WAIT_KEYS } from '@/lib/server/engine/types';
import { RECIPIENT, WAIT_LABEL, engineMessages } from '@/lib/server/engine/messages';
import { GROUND_RENT_FLAG_PENNIES_PA, MIN_EXTRACTION_CONFIDENCE, OFFER_EXPIRY_WARNING_DAYS, SHORT_LEASE_YEARS } from '@/lib/server/engine/rules';
import { CASE_RULES } from '@/lib/server/engine/rulebook';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The firm's rules as one page reads them: the timers (per wait, in working days, with the
 * firm's overrides), every message the engine sends (what triggers it, to whom, its subject
 * and the trust level that governs it), and the document rules with their thresholds.
 * Sign-offs come from /engine/shadow, which already tallies them.
 */
const DOCUMENT_RULES = [
  { id: 'extraction_confidence', document: 'Every document', rule: 'Read with less confidence than the threshold goes to a person, never guessed.', value: `${Math.round(MIN_EXTRACTION_CONFIDENCE * 100)}%` },
  { id: 'flag_severity', document: 'Every document', rule: 'Any flag at or above the severity floor turns a clear into a decision for a person.', value: 'low' },
  { id: 'search_flags', document: 'Search results', rule: 'Enforcement or contravention notices, unadopted roads, proposed schemes, contaminated land, radon, flood risk, conservation area, listing, TPOs, chancel liability, no public sewer or a sewer within 3m are flagged.', value: 'flag' },
  { id: 'enquiry_reply', document: 'Enquiry replies', rule: 'A reply that fully answers the enquiry clears it; a partial, evasive or "not known" reply goes to a person.', value: 'flag' },
  { id: 'offer_conditions', document: 'Mortgage offer', rule: 'Standard lender conditions clear; special conditions, a retention or a down-valuation go to a person.', value: 'flag' },
  { id: 'offer_expiry', document: 'Mortgage offer', rule: 'An offer expiring within this many days of the target exchange is flagged.', value: `${OFFER_EXPIRY_WARNING_DAYS} days` },
  { id: 'title_entries', document: 'Official copies', rule: 'Restrictions, charges to be discharged and restrictive covenants go to a person; a tenure that does not match the instruction is flagged.', value: 'flag' },
  { id: 'lease_short', document: 'Official copies (leasehold)', rule: 'A lease with fewer unexpired years than this is flagged.', value: `${SHORT_LEASE_YEARS.flag} years` },
  { id: 'lease_serious', document: 'Official copies (leasehold)', rule: 'Fewer than this many years is a serious flag (lender and marketability).', value: `${SHORT_LEASE_YEARS.serious} years` },
  { id: 'ground_rent', document: 'Official copies (leasehold)', rule: 'Ground rent above this a year, or a doubling or RPI review clause, is flagged.', value: `£${(GROUND_RENT_FLAG_PENNIES_PA / 100).toLocaleString('en-GB')}` },
  { id: 'id_outcome', document: 'ID / AML report', rule: 'Clear passes; referred goes to a person with the report; a fail halts the case. A PEP or sanctions hit is never cleared by rule.', value: 'refer / fail' },
  { id: 'pof', document: 'Proof of funds', rule: 'A shortfall against price less mortgage, a gift, an overseas source, or large or unexplained credits on the statements draft a query to the client. Sign-off is always a person.', value: 'query' },
];

const timerSchema = z.object({ waitKey: z.enum(WAIT_KEYS), chaseAfter: z.number().int().min(0).max(365), chaseEvery: z.number().int().min(1).max(365).nullable(), escalateAfter: z.number().int().min(0).max(365), reEscalateAfter: z.number().int().min(0).max(365) });

export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    const svc = engine();
    const [levels, sla] = await Promise.all([svc.levels(user.tenantId), svc.eventStore.loadSla(user.tenantId)]);
    const timers = WAIT_KEYS.map((k) => ({ waitKey: k, label: WAIT_LABEL[k], to: RECIPIENT[sla[k].recipientRole], chaseAfter: sla[k].chaseAfter, chaseEvery: sla[k].chaseEvery, escalateAfter: sla[k].escalateAfter, reEscalateAfter: sla[k].reEscalateAfter, overridden: JSON.stringify([sla[k].chaseAfter, sla[k].chaseEvery, sla[k].escalateAfter, sla[k].reEscalateAfter]) !== JSON.stringify([DEFAULT_SLA[k].chaseAfter, DEFAULT_SLA[k].chaseEvery, DEFAULT_SLA[k].escalateAfter, DEFAULT_SLA[k].reEscalateAfter]) }));
    const signoffs = await query<{ rule_id: string; signed_at: string; name: string | null }>(`select s.rule_id, s.signed_at, coalesce(u.display_name, u.email) as name from rule_signoff s left join app_user u on u.id = s.signed_by where s.tenant_id = $1`, [user.tenantId]).catch(() => []);
    const policies = await allPolicies(user.tenantId);
    return ok({ policies, timers, messages: engineMessages(levels), documentRules: DOCUMENT_RULES, caseRules: CASE_RULES, signoffs: Object.fromEntries(signoffs.map((s) => [s.rule_id, { at: s.signed_at, by: s.name }])) });
  } catch (error) {
    return fail(error);
  }
}

/** Timers: one wait's numbers, in working days. Matching the default removes the override. */
export async function PUT(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    const t = timerSchema.parse(await req.json());
    const d = DEFAULT_SLA[t.waitKey];
    const same = t.chaseAfter === d.chaseAfter && t.chaseEvery === d.chaseEvery && t.escalateAfter === d.escalateAfter && t.reEscalateAfter === d.reEscalateAfter;
    if (same) await query(`delete from engine_sla_override where tenant_id = $1 and wait_key = $2`, [user.tenantId, t.waitKey]);
    else
      await query(
        `insert into engine_sla_override (tenant_id, wait_key, chase_after, chase_every, escalate_after, re_escalate_after) values ($1, $2, $3, $4, $5, $6)
         on conflict (tenant_id, wait_key) do update set chase_after = excluded.chase_after, chase_every = excluded.chase_every, escalate_after = excluded.escalate_after, re_escalate_after = excluded.re_escalate_after`,
        [user.tenantId, t.waitKey, t.chaseAfter, t.chaseEvery, t.escalateAfter, t.reEscalateAfter]
      );
    await writeAudit({ tenantId: user.tenantId, matterId: null, actorUserId: user.userId, actionType: 'ENGINE_SLA', actionStatus: 'SUCCESS', payload: t }).catch(() => {});
    return ok({ saved: true });
  } catch (error) {
    return fail(error);
  }
}

const signoffSchema = z.object({ ruleId: z.string().min(1).max(80), signed: z.boolean() });

/** Sign a rule off for the firm, or withdraw the signature. Who and when are kept; both are audited. */
export async function POST(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    const s = signoffSchema.parse(await req.json());
    const known = CASE_RULES.some((r) => r.id === s.ruleId) || DOCUMENT_RULES.some((r) => r.id === s.ruleId);
    if (!known) return fail(Object.assign(new Error('Unknown rule.'), { status: 404 }));
    if (s.signed) await query(`insert into rule_signoff (tenant_id, rule_id, signed_by) values ($1, $2, $3) on conflict (tenant_id, rule_id) do update set signed_by = excluded.signed_by, signed_at = now()`, [user.tenantId, s.ruleId, user.userId]);
    else await query(`delete from rule_signoff where tenant_id = $1 and rule_id = $2`, [user.tenantId, s.ruleId]);
    await writeAudit({ tenantId: user.tenantId, matterId: null, actorUserId: user.userId, actionType: 'RULE_SIGNOFF', actionStatus: 'SUCCESS', payload: s }).catch(() => {});
    return ok({ saved: true });
  } catch (error) {
    return fail(error);
  }
}

/** A firm policy switch (protect outgoing files). Admins only. */
export async function PATCH(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    const input = z.object({ key: z.enum(['protectOutgoingFiles', 'archiveHandledEmail']), value: z.boolean() }).parse(await req.json());
    await setPolicy(user.tenantId, input.key, input.value, user.userId);
    return ok({ saved: true, policies: await allPolicies(user.tenantId) });
  } catch (error) {
    return fail(error);
  }
}
