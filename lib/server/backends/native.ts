/**
 * CaseLightning as the backend: our own matter rows, OneDrive / document_blob documents,
 * matter_task for what needs doing, matter_timeline_event for what happened.
 *
 * Conclusions: a surfaced decision → an open task on the matter (type DECISION, source
 * ENGINE, assigned to the handler, with the decision-panel link); its resolution → the
 * task DONE plus a timeline entry with the option, reason and sources; orders, chases,
 * sends and eventualities → one timeline line each. Stage moves are already mirrored by
 * the event store. Never on a shadow matter. Idempotent per event (the task detail
 * carries the event id; a timeline row is keyed by source_ref).
 */
import { query, queryOne, runAsSystem } from '../db';
import { PgDocumentBytesLoader, PgDocumentRepository } from '../engine/pg-documents';
import type { CaseBackend, ConclusionSink, MatterDirectory } from '../engine/backend';
import { DECISION_EVENT_TYPES, SUBFLOW_OF_KIND, surfacedDecisions, type DecisionKind, type DecisionOption, type EngineEvent, type MatterState } from '../engine/types';
import { optionLabel } from '../engine/rules';
import { TRIGGERS_BY_BACKEND } from '../engine/triggers';
import { config } from '../config';

const RESOLVING = new Set(['id_check_reviewed', 'search_reviewed', 'enquiry_reply_reviewed', 'mortgage_condition_reviewed', 'title_reviewed', 'report_on_title_approved', 'report_on_title_rejected', 'bank_details_verified', 'bank_details_verification_failed', 'escalation_resolved', 'hmlr_requisition_responded']);
const LINES: Record<string, (p: Record<string, unknown>) => string> = {
  search_ordered: (p) => `${p.searchType} search ordered via ${p.provider}${p.reissue ? ' (re-ordered)' : ''}`,
  id_check_requested: (p) => `ID/AML check requested via ${p.provider}`,
  chase_sent: (p) => `Chase sent to ${String(p.recipientRole).replace(/_/g, ' ')} re ${p.waitKey}${p.subject ? ` ${p.subject}` : ''}`,
  client_update_sent: (p) => `Client status update sent: ${p.template}`,
  report_on_title_sent: () => 'Report on title sent to the client (after human approval)',
  enquiry_raised: (p) => `Enquiry ${p.enquiryId} raised: ${p.subject}`,
  enquiry_withdrawn: (p) => `Enquiry ${p.enquiryId} withdrawn: ${p.reason}`,
  manual_handling_required: (p) => `Engine stopped for manual handling: ${p.reason}`,
  matter_abandoned: (p) => `Matter abandoned (${String(p.reason).replace(/_/g, ' ')})${p.detail ? `: ${p.detail}` : ''}`,
  target_dates_changed: (p) => `Target dates: exchange ${p.targetExchangeDate ?? '—'}, completion ${p.targetCompletionDate ?? '—'}${p.reason ? ` (${p.reason})` : ''}`,
  completion_date_changed: (p) => `Completion date moved ${p.from} → ${p.to}${p.reason ? ` (${p.reason})` : ''}`,
  mortgage_offer_withdrawn: (p) => `Mortgage offer withdrawn: ${p.reason}`,
  contracts_exchanged: (p) => `Contracts exchanged; completion ${p.completionDate}`,
  completion_confirmed: () => 'Completion confirmed',
  handler_changed: (p) => `Handler changed${p.reason ? `: ${p.reason}` : ''}`,
  correction_recorded: (p) => `Correction recorded: ${p.reason}`,
};
const firstLine = (s: string) => (s.split('\n').find((l) => l.trim()) ?? '').trim();

export class NativeConclusionSink implements ConclusionSink {
  readonly name = 'native-tasks-and-timeline';
  constructor(private subflows: (tenantId: string) => Promise<Parameters<typeof surfacedDecisions>[1]>) {}

  async onEvents({ tenantId, matterId, events, state }: { tenantId: string; matterId: string; events: EngineEvent[]; state: MatterState }): Promise<void> {
    if (!events.length || state.shadowMode) return;
    const cfg = await this.subflows(tenantId);
    const surfaced = new Set(surfacedDecisions(state, cfg).map((d) => d.eventId));
    const { createTask, updateTask } = await import('../tasks');
    const { emitMatterEvent } = await import('../events');
    const m = await runAsSystem(() => queryOne<{ assigned_to: string | null; created_by: string }>(`select assigned_to, created_by from matter where id = $1 and tenant_id = $2`, [matterId, tenantId]));
    if (!m) return;
    const handler = m.assigned_to ?? m.created_by;
    const actorUser = { userId: handler, tenantId, role: 'CONVEYANCER' as const, email: '', displayName: null };
    for (const e of events) {
      try {
        const p = e.payload as Record<string, unknown>;
        if (DECISION_EVENT_TYPES.includes(e.type)) {
          const d = state.decisions[e.id];
          if (!d || !surfaced.has(e.id) || d.kind === 'auto_clear') continue;
          const tag = `[engine:${e.id}]`;
          const dup = await runAsSystem(() => queryOne<{ id: string }>(`select id from matter_task where matter_id = $1 and detail like $2 limit 1`, [matterId, `%${tag}`]));
          if (dup) continue;
          const sf = SUBFLOW_OF_KIND[d.kind as DecisionKind];
          const detail = `Decision needed — ${d.kind.replace(/_/g, ' ')}${d.subject ? ` · ${d.subject.replace(/^[a-z_]+:/, '')}` : ''}: ${firstLine(d.summary)} → ${config.appUrl}/decisions/${e.id}${sf ? ` (${sf})` : ''} ${tag}`;
          await runAsSystem(() => createTask(actorUser, matterId, { type: 'DECISION', detail, assigneeUserId: handler, source: 'ENGINE', status: 'OPEN' }));
          continue;
        }
        if (RESOLVING.has(e.type)) {
          const decisionEventId = String(p.decisionEventId ?? '');
          const d = decisionEventId ? state.decisions[decisionEventId] : null;
          if (d?.kind === 'auto_clear') continue;
          const task = decisionEventId ? await runAsSystem(() => queryOne<{ id: string; status: string }>(`select id, status from matter_task where matter_id = $1 and detail like $2 limit 1`, [matterId, `%[engine:${decisionEventId}]`])) : null;
          if (task && task.status !== 'DONE') await runAsSystem(() => updateTask(actorUser, matterId, task.id, { status: 'DONE', statusLabel: `Resolved in CONVEYi: ${p.option ? optionLabel(String(p.option) as DecisionOption) : e.type}` }));
          const who = /^[0-9a-f-]{36}$/i.test(e.actor) ? (await runAsSystem(() => queryOne<{ name: string }>(`select coalesce(display_name, email) as name from app_user where id = $1`, [e.actor])))?.name ?? e.actor : e.actor;
          const option = p.option ? optionLabel(String(p.option) as DecisionOption) : p.method ? `verified out-of-band (${String(p.method).replace(/_/g, ' ')})` : e.type.replace(/_/g, ' ');
          await this.timeline(tenantId, matterId, e, 'ENGINE_DECISION_RESOLVED', `Engine: ${d ? `${d.kind.replace(/_/g, ' ')}${d.subject ? ` · ${d.subject.replace(/^[a-z_]+:/, '')}` : ''} — ` : ''}${option} by ${who}`, [p.note ? `Reason: ${p.note}` : null, d?.citations?.length ? `Sources: ${d.citations.map((c) => c.label).join('; ')}` : null, `${config.appUrl}/decisions/${decisionEventId || e.id}`].filter(Boolean).join('\n'));
          continue;
        }
        const line = LINES[e.type];
        if (line) await this.timeline(tenantId, matterId, e, `ENGINE_${e.type.toUpperCase()}`, `Engine: ${line(p)}`, null);
        void emitMatterEvent;
      } catch (err) {
        console.warn(`[native-backend] conclusion write failed for ${e.type} #${e.seq}`, (err as Error).message);
      }
    }
  }

  private async timeline(tenantId: string, matterId: string, e: EngineEvent, eventType: string, title: string, details: string | null): Promise<void> {
    await runAsSystem(() => query(
      `insert into matter_timeline_event (tenant_id, matter_id, event_at, event_type, title, details, source_ref)
       select $1,$2,now(),$3,$4,$5,$6::jsonb where not exists (select 1 from matter_timeline_event where matter_id = $2 and source_ref->>'eventId' = $7)`,
      [tenantId, matterId, eventType, title, details, JSON.stringify({ eventId: e.id, seq: e.seq }), e.id]
    )).catch(() => {});
  }
}

export class NativeMatterDirectory implements MatterDirectory {
  async handlerOf(tenantId: string, matterId: string): Promise<string | null> {
    const m = await runAsSystem(() => queryOne<{ assigned_to: string | null; created_by: string }>(`select assigned_to, created_by from matter where id = $1 and tenant_id = $2`, [matterId, tenantId]));
    return m?.assigned_to ?? m?.created_by ?? null;
  }
  async externalRef(tenantId: string, matterId: string): Promise<string | null> {
    const m = await runAsSystem(() => queryOne<{ matter_ref: string; firm_ref: string | null }>(`select matter_ref, firm_ref from matter where id = $1 and tenant_id = $2`, [matterId, tenantId]));
    return m?.firm_ref ?? m?.matter_ref ?? null;
  }
}

export function nativeBackend(subflows: (tenantId: string) => Promise<Parameters<typeof surfacedDecisions>[1]>): CaseBackend {
  return {
    kind: 'native',
    label: 'CaseLightning (own app)',
    documents: new PgDocumentRepository(),
    bytes: new PgDocumentBytesLoader(),
    conclusions: new NativeConclusionSink(subflows),
    matters: new NativeMatterDirectory(),
    triggers: TRIGGERS_BY_BACKEND('native'),
    status: async () => ({ ok: true, detail: 'matters, documents and tasks in CaseLightning; documents in OneDrive / document_blob' }),
  };
}

/**
 * The native app changed a matter's assignment (PATCH /matters/:id). Put it on the
 * engine log when the matter is enrolled. Best-effort: assignment is not an engine
 * precondition, the log is the audit trail.
 */
export async function onNativeMatterReassigned(tenantId: string, matterId: string, fromUserId: string | null, toUserId: string | null, actor: string): Promise<void> {
  if (!toUserId) return;
  try {
    const { engine } = await import('../engine/adapters');
    const svc = engine();
    const state = await svc.getState(tenantId, matterId);
    if (!state.enrolled || state.handler === toUserId) return;
    await svc.run(tenantId, matterId, { type: 'record_handler_change', actor, fromUserId, toUserId, reason: 'reassigned in the app' });
  } catch (err) {
    console.warn('[native-backend] could not record the handler change', (err as Error).message);
  }
}
