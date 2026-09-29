/**
 * What the case view opens with, built from ONE read of the log. The five things the page
 * used to fetch separately (engine view, events, graph model, board row, summary) each
 * replayed the same log; here the state is projected once and every view is derived from it.
 * The single-purpose routes still exist and call the same builders.
 */
import { dismissedRefs } from '../task-dismissal';
import { dueSteps } from './due';
import { query, queryOne } from '../db';
import { boardSelect, type BoardMatter } from '../board';
import { listAssignees } from '../tasks';
import { DEFAULT_SLA, nextChase } from './sla';
import { fundsFromFor } from './shapes';
import { computeSdlt, sdltLabel } from './sdlt';
import { stageBlockers } from './machine';
import { pendingDecisions, openWaits, surfacedDecisions, type MatterState } from './types';
import { COMPLETION_CONTRACTS } from './completion';
import { profileOf } from './transactions';
import { caseGraph, gate, gatesFor, lifecycle, lifecycleFor, nextActions, requirements, whyNot, workstreams, LIFECYCLE_LABEL } from './graph';
import { caseHealth } from './health';
import { matterWork } from './work';
import { caseHud } from './hud';
import type { EngineService } from './service';

/** The other half of the client's chain, as this case's page shows it: where it is, what holds its exchange, when it completes. */
export async function chainView(svc: EngineService, tenantId: string, state: MatterState) {
  const link = state.relatedMatter;
  if (!link) return null;
  const [other, row] = await Promise.all([
    svc.getState(tenantId, link.matterId).catch(() => null),
    queryOne<{ matter_ref: string | null; property_address: string | null; completion_target_date: string | null }>(`select matter_ref, property_address, completion_target_date::text from matter where id = $1 and tenant_id = $2`, [link.matterId, tenantId]).catch(() => null),
  ]);
  return {
    matterId: link.matterId,
    relation: link.relation,
    matterRef: row?.matter_ref ?? null,
    propertyAddress: row?.property_address ?? null,
    readable: !!other,
    stage: other?.stage ?? null,
    exchangedAt: other?.exchange.exchangedAt ?? null,
    exchangeReady: !!other && (!!other.exchange.exchangedAt || (other.stage === 'pre_exchange' && other.exchange.conditionsMet && !other.abandoned)),
    holding: other ? stageBlockers(other).slice(0, 3) : [],
    completionDate: other?.exchange.completionDate ?? null,
    targetCompletion: other?.targetCompletionDate ?? row?.completion_target_date ?? null,
    completedAt: other?.completion.confirmedAt ?? null,
    abandoned: !!other?.abandoned,
  };
}

/** The engine's view of a matter: state, profile, blockers, waits, decisions, levels and the matter row. (Its billing is not shown to anyone working the case.) */
export async function engineView(svc: EngineService, tenantId: string, matterId: string, state: MatterState) {
  // The people named on the page (who asked for what): only ids that are users.
  const personIds = [...new Set(state.waits.map((w) => w.openedBy).filter((id): id is string => !!id && /^[0-9a-f-]{36}$/i.test(id)))];
  const [subflows, matter, sla, docCount, people] = await Promise.all([
    svc.levels(tenantId),
    queryOne<{ matter_ref: string; property_address: string; stage: string | null; shadow_mode: boolean | null; assigned_to: string | null; handler: string | null; sandbox: boolean; sandbox_scenario: string | null; sandbox_step: string | null }>(
      `select m.matter_ref, m.property_address, m.stage, m.shadow_mode, m.assigned_to, coalesce(u.display_name, u.email) as handler, m.sandbox, m.sandbox_scenario, m.sandbox_step
         from matter m left join app_user u on u.id = m.assigned_to where m.id = $1 and m.tenant_id = $2`,
      [matterId, tenantId]
    ).catch(() => null),
    svc.eventStore.loadSla(tenantId).catch(() => DEFAULT_SLA),
    // What the Documents tab lists: the case's papers, not the generated notes, emails and dossiers the timeline carries.
    queryOne<{ n: number }>(`select count(*)::int as n from document where tenant_id = $1 and matter_id = $2 and superseded_at is null and coalesce(doc_type, '') not in ('FILE_NOTE', 'EMAIL', 'ESCALATION_DOSSIER', 'DEADLINE_DOSSIER', 'PROPOSAL', 'BANK_DETAILS_NOTE', 'SANDBOX_EMAIL')`, [tenantId, matterId]).then((r) => r?.n ?? 0).catch(() => 0),
    personIds.length ? query<{ id: string; name: string }>(`select id, coalesce(display_name, email) as name from app_user where tenant_id = $1 and id = any($2::uuid[])`, [tenantId, personIds]).catch(() => []) : Promise.resolve([] as Array<{ id: string; name: string }>),
  ]);
  const profile = profileOf(state.transactionType);
  const chain = await chainView(svc, tenantId, state).catch(() => null);
  // Tasks a person dismissed stay out of the case's tray and counts (restorable from Dismissed).
  const gone = await dismissedRefs(tenantId, matterId);
  const kept = <T extends { eventId: string }>(ds: T[]) => ds.filter((d) => !gone.has(`${matterId}|decision:${d.eventId}`));
  return {
    state,
    chain,
    // The transaction profile (docs/transaction-types.md): which phases, workstreams and gates this type has — the UI draws from it.
    profile: { ...profile, fundsFrom: fundsFromFor(profile.fundsFrom, state.shapes ?? []), lifecycle: lifecycleFor(profile), gates: gatesFor(state) },
    sdlt: profile.side === 'buyer' && state.purchasePricePennies ? (() => { const basis = { ...(state.sdltBasis ?? { firstTimeBuyer: false, additionalProperty: false, nonUkResident: false }), company: state.shapes?.includes('company_buyer') ?? false }; const est = computeSdlt(state.purchasePricePennies, basis); return { estimatePennies: est.totalPennies, scheme: est.scheme, basis: sdltLabel(basis), declared: !!state.sdltBasis }; })() : null,
    lifecycle: { id: lifecycle(state), label: LIFECYCLE_LABEL[lifecycle(state)] },
    blockers: stageBlockers(state),
    waits: openWaits(state).map((w) => ({ ...w, chase: sla[w.key] ? nextChase(w, sla[w.key], new Date()) : null })),
    // Everything the log holds (the panel shows the engine's conclusions) …
    pendingDecisions: kept(pendingDecisions(state)),
    // What is waiting on us (due.ts): the Tasks tab lists it with the form that records each.
    due: dueSteps(state, new Date()).filter((d) => !gone.has(`${matterId}|step:${d.key}`)),
    documentCount: docCount,
    people: Object.fromEntries(people.map((p) => [p.id, p.name])) as Record<string, string>,
    // … and what a person may act on (addendum 3 §2).
    surfacedDecisions: kept(surfacedDecisions(state)),
    levels: subflows,
    contracts: COMPLETION_CONTRACTS,
    matter: matter ? { matterRef: matter.matter_ref, propertyAddress: matter.property_address, legacyStage: matter.stage, shadowMode: !!matter.shadow_mode, assignedTo: matter.assigned_to, handler: matter.handler, sandbox: !!matter.sandbox, sandboxScenario: matter.sandbox_scenario, sandboxStep: matter.sandbox_step } : null,
  };
}

/** The case model as data (docs/case-model.md): lifecycle, workstreams, requirements, gates, next actions, health, HUD, graph. */
export function graphModel(state: MatterState, now: Date) {
  const lc = lifecycle(state);
  const profile = profileOf(state.transactionType);
  const gates = gatesFor(state);
  return {
    profile: { type: profile.type, label: profile.label, side: profile.side, hasExchange: profile.hasExchange, stages: profile.stages, stageLabels: profile.stageLabels, lifecycle: lifecycleFor(profile), gates, counterparty: profile.counterparty },
    lifecycle: { id: lc, label: LIFECYCLE_LABEL[lc], stage: state.stage },
    workstreams: workstreams(state, now),
    requirements: requirements(state),
    gates: Object.fromEntries(gates.map((g) => [g, gate(state, g)])),
    whyNotExchange: whyNot(state, gates[0]),
    // Case intelligence (docs/caseload-ux.md §3): what needs attention and why, what we
    // are waiting for with its clock, and this matter's slice of the work list.
    health: caseHealth(state, now),
    waits: openWaits(state),
    work: matterWork(state, now, { matterRef: null, propertyAddress: null }).items,
    nextActions: nextActions(state, now),
    graph: caseGraph(state, now),
    hud: caseHud(state, now),
  };
}

/** One matter in the shape the drawer opens with, plus the team for its owner dropdown. Throws 404 when there is no such case. */
export async function boardRow(tenantId: string, matterId: string): Promise<{ matter: BoardMatter; assignees: Awaited<ReturnType<typeof listAssignees>> }> {
  let matter: BoardMatter | null;
  try {
    matter = await queryOne<BoardMatter>(`${boardSelect(true)} where m.tenant_id = $1 and m.id = $2`, [tenantId, matterId]);
  } catch {
    // matter_task not present on this install — the drawer still opens without badges.
    matter = await queryOne<BoardMatter>(`${boardSelect(false)} where m.tenant_id = $1 and m.id = $2`, [tenantId, matterId]);
  }
  if (!matter) throw Object.assign(new Error('Case not found.'), { status: 404 });
  const assignees = await listAssignees(tenantId).catch(() => [] as Awaited<ReturnType<typeof listAssignees>>);
  return { matter, assignees };
}
