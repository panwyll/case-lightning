/**
 * CONVEYi → LEAP: write-back (phase 1).
 *
 * The engine's conclusions appear in the firm's own case file so nobody has to look in
 * two places: a decision that needs a person becomes a LEAP task on the matter (with
 * the link into the decision panel), its resolution completes that task and leaves a
 * file note (option, reason, who, citations), and stage moves, chases, client updates
 * and sends each leave a one-line file note.
 *
 * Rules:
 *   - runs post-commit, as automation, off the event log (the log is the truth; LEAP is
 *     a projection of it — a failed write is retried by the next sync, never a reason
 *     to fail the command);
 *   - never in shadow mode: a shadow matter's engine conclusions stay on our side
 *     (that is the comparison the rollout depends on), and a shadowed sub-flow's
 *     decisions are not surfaced anywhere, LEAP included;
 *   - never writes AI-drafted client content into LEAP as anything but a clearly
 *     labelled DRAFT document (LeapDocumentRepository.createGenerated, adapters.ts);
 *     the send itself still needs the human approval event;
 *   - idempotent per (event, kind) through the write-back store.
 */
import type { LeapApi } from './client';
import { tagExternalRef } from './mapping';
import { DECISION_EVENT_TYPES, SUBFLOW_OF_KIND, surfacedDecisions, type DecisionKind, type DecisionOption, type EngineEvent, type MatterState, type SubflowConfig } from '../../engine/types';
import { optionLabel } from '../../engine/rules';

export interface LeapWritebackStore {
  find(eventId: string, kind: WritebackKind): Promise<{ leapId: string | null; status: string } | null>;
  record(input: { tenantId: string; matterId: string; eventId: string; kind: WritebackKind; leapId: string | null; status: 'WRITTEN' | 'COMPLETED' | 'FAILED'; detail?: string | null }): Promise<void>;
  /** The LEAP matter behind one of our matters (null when the matter is not LEAP-backed), with the responsible staff id for task assignment. */
  leapMatter(tenantId: string, matterId: string): Promise<{ leapMatterId: string; staffId: string | null } | null>;
  /** Display name for a user id (for file notes). */
  userName(tenantId: string, userId: string): Promise<string | null>;
}

export type WritebackKind = 'task' | 'note' | 'status';

export interface WritebackDeps {
  leap: LeapApi;
  store: LeapWritebackStore;
  appUrl: string;
  subflows: (tenantId: string) => Promise<SubflowConfig>;
  options?: { tasks?: boolean; notes?: boolean };
  log: (msg: string, detail?: unknown) => void;
}

const RESOLVING_TYPES = new Set(['id_check_reviewed', 'search_reviewed', 'enquiry_reply_reviewed', 'mortgage_condition_reviewed', 'title_reviewed', 'report_on_title_approved', 'report_on_title_rejected', 'bank_details_verified', 'bank_details_verification_failed', 'auto_clear_confirmed', 'escalation_resolved']);
const NOTE_TYPES: Record<string, (p: Record<string, unknown>) => string> = {
  stage_advanced: (p) => `Stage → ${String(p.to).replace(/_/g, ' ')} (${p.reason})`,
  search_ordered: (p) => `${p.searchType} search ordered via ${p.provider}${p.reference ? ` (ref ${p.reference})` : ''}`,
  id_check_requested: (p) => `ID/AML check requested via ${p.provider}`,
  chase_sent: (p) => `Chase sent to ${String(p.recipientRole).replace(/_/g, ' ')} re ${p.waitKey}${p.subject ? ` ${p.subject}` : ''} (${p.template}, ${p.channel})`,
  client_update_sent: (p) => `Client status update sent: ${p.template} (${p.channel})`,
  report_on_title_sent: (p) => `Report on title sent to the client (${p.channel}) — approved by a person first (event ${p.approvedEventId})`,
  enquiry_raised: (p) => `Enquiry ${p.enquiryId} raised: ${p.subject}`,
  manual_handling_required: (p) => `Engine stopped for manual handling: ${p.reason}`,
  contracts_exchanged: (p) => `Contracts exchanged; completion ${p.completionDate}`,
  completion_confirmed: () => 'Completion confirmed',
  shadow_mode_changed: (p) => `CONVEYi shadow mode ${p.shadowMode ? 'on' : 'off'}${p.reason ? `: ${p.reason}` : ''}`,
};

const firstLine = (s: string) => (s.split('\n').find((l) => l.trim()) ?? '').trim();
const PREFIX = 'CONVEYi';

/** Apply one command's committed events to LEAP. Safe to call for any matter: non-LEAP matters and shadow matters are no-ops. */
export async function writeBack(deps: WritebackDeps, tenantId: string, matterId: string, events: EngineEvent[], state: MatterState): Promise<{ tasks: number; notes: number; completed: number; skipped: number }> {
  const out = { tasks: 0, notes: 0, completed: 0, skipped: 0 };
  if (!events.length) return out;
  const link = await deps.store.leapMatter(tenantId, matterId);
  if (!link) return out;
  const leapMatterId = link.leapMatterId;
  if (state.shadowMode) {
    out.skipped = events.length;
    return out;
  }
  const cfg = await deps.subflows(tenantId);
  const surfaced = new Set(surfacedDecisions(state, cfg).map((d) => d.eventId));
  const wantTasks = deps.options?.tasks !== false;
  const wantNotes = deps.options?.notes !== false;

  for (const e of events) {
    try {
      const p = e.payload as Record<string, unknown>;
      // A decision that needs a person → a LEAP task, unless it is hidden (shadowed sub-flow) or advisory.
      if (DECISION_EVENT_TYPES.includes(e.type) && wantTasks) {
        const d = state.decisions[e.id];
        if (!d || !surfaced.has(e.id) || d.kind === 'auto_clear') {
          out.skipped += 1;
          continue;
        }
        if (await deps.store.find(e.id, 'task')) continue;
        const url = `${deps.appUrl}/decisions/${e.id}`;
        const sf = SUBFLOW_OF_KIND[d.kind as DecisionKind];
        const title = `${PREFIX}: decision needed — ${d.kind.replace(/_/g, ' ')}${d.subject ? ` · ${d.subject.replace(/^[a-z_]+:/, '')}` : ''}`;
        const description = tagExternalRef(`${firstLine(d.summary)}\n\nOpen the source and decide in CONVEYi: ${url}\nOptions: ${d.options.map(optionLabel).join(' · ')}${sf ? `\nSub-flow: ${sf}` : ''}`, `decision:${e.id}`);
        const assignee = link.staffId;
        const t = await deps.leap.createTask(leapMatterId, { title, description, assigneeStaffId: assignee, externalRef: `decision:${e.id}` });
        await deps.store.record({ tenantId, matterId, eventId: e.id, kind: 'task', leapId: t.id, status: 'WRITTEN' });
        out.tasks += 1;
        continue;
      }
      // A resolution → complete the task and leave a note with the reasoning.
      if (RESOLVING_TYPES.has(e.type)) {
        const decisionEventId = String(p.decisionEventId ?? '');
        const d = decisionEventId ? state.decisions[decisionEventId] : null;
        if (d?.kind === 'auto_clear' || !wantNotes) {
          out.skipped += 1;
          continue;
        }
        const existing = decisionEventId ? await deps.store.find(decisionEventId, 'task') : null;
        if (existing?.leapId && existing.status !== 'COMPLETED') {
          await deps.leap.completeTask(existing.leapId, `Resolved in CONVEYi: ${String(p.option ?? e.type)}`);
          await deps.store.record({ tenantId, matterId, eventId: decisionEventId, kind: 'task', leapId: existing.leapId, status: 'COMPLETED' });
          out.completed += 1;
        }
        if (await deps.store.find(e.id, 'note')) continue;
        const who = /^[0-9a-f-]{36}$/i.test(e.actor) ? (await deps.store.userName(tenantId, e.actor)) ?? e.actor : e.actor;
        const option = p.option ? optionLabel(String(p.option) as DecisionOption) : p.method ? `verified out-of-band (${String(p.method).replace(/_/g, ' ')})` : e.type.replace(/_/g, ' ');
        const cites = d?.citations?.length ? `\nSources: ${d.citations.map((c) => c.label).join('; ')}` : '';
        const body = `${PREFIX}: ${d ? `${d.kind.replace(/_/g, ' ')}${d.subject ? ` · ${d.subject.replace(/^[a-z_]+:/, '')}` : ''} — ` : ''}${option} by ${who}${p.note ? `\nReason: ${p.note}` : ''}${p.reference ? `\nVerification ref: ${p.reference}` : ''}${cites}\n${deps.appUrl}/decisions/${decisionEventId || e.id}`;
        const n = await deps.leap.addNote(leapMatterId, body);
        await deps.store.record({ tenantId, matterId, eventId: e.id, kind: 'note', leapId: n.id, status: 'WRITTEN' });
        out.notes += 1;
        continue;
      }
      // Everything else worth a line in the file.
      const render = NOTE_TYPES[e.type];
      if (render && wantNotes) {
        if (await deps.store.find(e.id, 'note')) continue;
        const n = await deps.leap.addNote(leapMatterId, `${PREFIX}: ${render(p)}`);
        await deps.store.record({ tenantId, matterId, eventId: e.id, kind: 'note', leapId: n.id, status: 'WRITTEN' });
        out.notes += 1;
        continue;
      }
      out.skipped += 1;
    } catch (err) {
      deps.log(`LEAP write-back failed for ${e.type} #${e.seq}`, err);
      await deps.store.record({ tenantId, matterId, eventId: e.id, kind: DECISION_EVENT_TYPES.includes(e.type) ? 'task' : 'note', leapId: null, status: 'FAILED', detail: (err as Error).message }).catch(() => {});
    }
  }
  return out;
}
