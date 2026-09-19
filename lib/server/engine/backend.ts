/**
 * The case backend: where matters, documents and the firm's to-do list live.
 *
 * The engine (log, machine, rules, decisions, timers) is the same whichever practice
 * system the firm runs. What differs is (a) where a document's bytes are, (b) how a
 * generated document is filed, (c) where the engine's conclusions are shown to the
 * firm, and (d) which triggers can fire. That is this interface, with two
 * implementations:
 *
 *   NativeBackend — CaseLightning's own tables: `document` rows in OneDrive / document_blob,
 *                   matter_task for decisions, matter_timeline_event for the record.
 *   LeapBackend   — LEAP (leap.build) as the system of record: bytes fetched from LEAP,
 *                   drafts uploaded into the LEAP matter, tasks + file notes written back.
 *
 * productionPorts() composes the engine's ports from the selected backend; nothing in
 * machine.ts, projection.ts, rules.ts or sla.ts knows which one is in use.
 */
import type { DocumentBytesLoader } from './extraction';
import type { DocumentRepository } from './ports';
import type { EngineEvent, MatterState } from './types';
import type { TriggerSpec } from './triggers';

export type BackendKind = 'native' | 'leap';

/** Where the engine's conclusions are shown to the firm (tasks, notes, timeline). Runs post-commit, as automation. */
export interface ConclusionSink {
  readonly name: string;
  onEvents(input: { tenantId: string; matterId: string; events: EngineEvent[]; state: MatterState }): Promise<void>;
}

/** What the engine needs to know about a matter from the practice system. */
export interface MatterDirectory {
  /** The responsible handler's user id (for task assignment and the queue), or null. */
  handlerOf(tenantId: string, matterId: string): Promise<string | null>;
  /** The practice system's reference for a matter (LEAP matter id / our matter ref), for notes and links. */
  externalRef(tenantId: string, matterId: string): Promise<string | null>;
}

export interface CaseBackend {
  readonly kind: BackendKind;
  readonly label: string;
  documents: DocumentRepository;
  bytes: DocumentBytesLoader;
  conclusions: ConclusionSink | null;
  matters: MatterDirectory;
  /** The triggers that can fire on this backend (for the map and the docs). */
  triggers: TriggerSpec[];
  /** Health for /api/v1/health and /engine/map. */
  status(): Promise<{ ok: boolean; detail: string }>;
}
