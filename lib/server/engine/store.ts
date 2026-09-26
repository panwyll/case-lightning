/**
 * Event store — append-only persistence for the engine's log.
 *
 * Two implementations of one interface: MemoryEventStore (tests / dev without a DB)
 * and PgEventStore (Postgres, migration 065). Both guarantee:
 *   - events for a matter are appended under a per-matter lock with an expected
 *     last-seq check (optimistic concurrency: two racing commands cannot both win);
 *   - seq is 1-based and gap-free per matter;
 *   - rows are never updated or deleted (Postgres enforces this with a trigger).
 *
 * The Postgres store also maintains two READ MODELS that are pure projections of the
 * log and can be rebuilt from it at any time: matter_engine_state (state jsonb, for
 * cross-matter queries and the timer sweep) and matter_decision (the dashboard feed).
 * It also mirrors stage moves onto the legacy `matter.stage` column + timeline so the
 * existing board keeps working.
 */
import type pg from 'pg';
import { query as dbQuery, transaction as dbTransaction } from '../db';
import { project } from './projection';
import { chainEvents } from './audit';
import { DEFAULT_SLA, withOverrides, type SlaConfig, type SlaRule } from './sla';
import { caseHealth, summariseHealth, type HealthSummary } from './health';
import { lifecycle, type Lifecycle } from './graph';
import { DEFAULT_LEVELS, ENGINE_ACTIONS, TRUST_LEVELS, type EngineAction, LEGACY_STAGE, STAGES, SUB_FLOWS, SUBFLOW_OF_KIND, openIssues, pendingDecisions, surfacedDecisions, withStateDefaults, type DecisionState, type EngineEvent, type MatterState, type NewEvent, type SubFlow, type LevelConfig, type TrustLevel, type TransactionType, type WaitKey } from './types';

export interface MatterTx {
  load(): Promise<EngineEvent[]>;
  /** Append in order. `expectedLastSeq` must equal the current max seq or the append fails (concurrent writer). */
  append(events: NewEvent[], expectedLastSeq: number, now: Date, newId: () => string): Promise<EngineEvent[]>;
  /** Refresh read models from the freshly projected state. */
  afterAppend(state: MatterState, appended: EngineEvent[]): Promise<void>;
}

export interface EnrolledMatter {
  tenantId: string;
  matterId: string;
  stage: string;
}

export interface PendingDecisionRow extends DecisionState {
  tenantId: string;
  matterId: string;
  matterRef: string | null;
  propertyAddress: string | null;
  /** The fee-earner the matter is assigned to, so a tray can show a person their own. */
  assignedTo?: string | null;
  stage: string;
  shadowMode: boolean;
}

/** Addendum 3 §3: one queue row per matter; also the caseload map's token (docs/caseload-ux.md). */
export interface QueueRow {
  transactionType: TransactionType | null;
  tenantId: string;
  matterId: string;
  matterRef: string | null;
  propertyAddress: string | null;
  stage: string;
  shadowMode: boolean;
  assignedTo: string | null;
  /** Surfaced decisions waiting on a person (assist-level auto-clear reviews excluded). */
  pendingCount: number;
  /** Advisory auto-clear reviews waiting (assist level). */
  reviewCount: number;
  /** Every pending decision in the log, surfaced or not (the rollout board counts shadow conclusions). */
  loggedCount: number;
  oldestPendingAt: string | null;
  /** Open / negotiating issues (docs/engine-issues.md) — the things the matter is waiting on that are not decisions. */
  openIssues: number;
  /** Of those, the ones holding exchange or completion. */
  holdingIssues: number;
  targetCompletionDate: string | null;
  targetExchangeDate: string | null;
  manualHandling: boolean;
  updatedAt: string;
  /** The coarse band the caseload map groups by. */
  lifecycle: Lifecycle;
  /** Health, with the one line that explains it (health.ts). Not case age. */
  health: HealthSummary;
  /** Days since the matter was instructed — shown as "day 43", never used to judge health. */
  dayOfCase: number;
}

export interface QueueOptions {
  /** Only matters assigned to this handler (the default view); null → every enrolled matter. */
  assignedTo?: string | null;
  /** Include matters that have finished (closed / abandoned) — off by default. */
  includeFinished?: boolean;
  sort?: 'oldest_pending' | 'target_completion';
  includeShadow?: boolean;
  limit?: number;
}

/** Addendum 3 §2: a person's record of whether the engine's conclusion matched what they actually did. */
export interface ShadowReview {
  id: string;
  tenantId: string;
  matterId: string;
  eventId: string;
  subFlow: string;
  agrees: boolean;
  humanOutcome: string | null;
  note: string | null;
  reviewer: string;
  createdAt: string;
}

export interface EventStore {
  withMatterLock<T>(tenantId: string, matterId: string, fn: (tx: MatterTx) => Promise<T>): Promise<T>;
  listEvents(tenantId: string, matterId: string, opts?: { afterSeq?: number; limit?: number }): Promise<EngineEvent[]>;
  /** Matters the timer sweep should visit (enrolled and not finished). */
  listActiveMatters(tenantId?: string | null): Promise<EnrolledMatter[]>;
  /**
   * Decisions a person may be shown: pending, on non-shadow matters, from non-shadow
   * sub-flows (addendum 3 §2). `includeShadow` is for the comparison view only.
   */
  listPendingDecisions(tenantId: string, opts?: { matterId?: string | null; limit?: number; includeShadow?: boolean }): Promise<PendingDecisionRow[]>;
  /** Any decision (pending or not) by its event id — the dashboard's detail/resolve routes need the matter it belongs to. */
  findDecision(tenantId: string, eventId: string): Promise<PendingDecisionRow | null>;
  loadSla(tenantId: string): Promise<SlaConfig>;
  /** The cached read model, for the audit's replay check (null when none / in memory). */
  cachedState(tenantId: string, matterId: string): Promise<MatterState | null>;
  /** Trust level per engine action. Missing rows are `propose`. */
  loadLevels(tenantId: string): Promise<LevelConfig>;
  /** `key` is an action or `action:subject`; setting an action clears its subjects' overrides. */
  setLevel(tenantId: string, key: string, level: TrustLevel, userId: string | null): Promise<LevelConfig>;
  /** Addendum 3 §3: the handler's queue — one row per matter. */
  listQueue(tenantId: string, opts?: QueueOptions): Promise<QueueRow[]>;
  /** Full state per matter, for anything that has to reason over the whole caseload (the work list). */
  listStates(tenantId: string, opts?: QueueOptions): Promise<Array<{ state: MatterState; meta: { matterRef: string | null; propertyAddress: string | null; assignedTo: string | null } }>>;
  /** Addendum 3 §2: the comparison record. */
  listShadowReviews(tenantId: string, matterId?: string | null): Promise<ShadowReview[]>;
  recordShadowReview(input: Omit<ShadowReview, 'id' | 'createdAt'>): Promise<ShadowReview>;
}

const row = (s: MatterState, d: DecisionState, meta: { matterRef: string | null; propertyAddress: string | null; assignedTo?: string | null } | undefined): PendingDecisionRow => ({ ...d, tenantId: s.tenantId, matterId: s.matterId, matterRef: meta?.matterRef ?? null, propertyAddress: meta?.propertyAddress ?? null, assignedTo: meta?.assignedTo ?? null, stage: s.stage, shadowMode: s.shadowMode });

function queueRow(s: MatterState, meta: { matterRef: string | null; propertyAddress: string | null; assignedTo?: string | null; updatedAt?: string } | undefined, _cfg: LevelConfig | null, now: Date = new Date()): QueueRow {
  const surfaced = surfacedDecisions(s);
  const pending = surfaced.filter((d) => d.kind !== 'auto_clear');
  return {
    tenantId: s.tenantId,
    matterId: s.matterId,
    matterRef: meta?.matterRef ?? null,
    propertyAddress: meta?.propertyAddress ?? null,
    transactionType: s.transactionType,
    stage: s.stage,
    shadowMode: s.shadowMode,
    assignedTo: meta?.assignedTo ?? null,
    pendingCount: pending.length,
    reviewCount: surfaced.length - pending.length,
    loggedCount: pendingDecisions(s).length,
    oldestPendingAt: pending.length ? pending[0].createdAt : null,
    openIssues: openIssues(s).length,
    holdingIssues: openIssues(s).filter((i) => i.gate !== 'none').length,
    targetCompletionDate: s.targetCompletionDate,
    targetExchangeDate: s.targetExchangeDate,
    manualHandling: s.manualHandling.required,
    updatedAt: meta?.updatedAt ?? s.lastEventAt ?? '',
    lifecycle: lifecycle(s),
    health: summariseHealth(caseHealth(s, now)),
    dayOfCase: s.stageHistory.length ? Math.max(0, Math.floor((now.getTime() - new Date(s.stageHistory[0].at).getTime()) / 86_400_000)) : 0,
  };
}

function sortQueue(rows: QueueRow[], sort: QueueOptions['sort']): QueueRow[] {
  const byPending = (a: QueueRow, b: QueueRow) => {
    // Matters with something waiting first, oldest waiting decision first; the rest by last activity.
    if (a.oldestPendingAt && b.oldestPendingAt) return a.oldestPendingAt.localeCompare(b.oldestPendingAt);
    if (a.oldestPendingAt) return -1;
    if (b.oldestPendingAt) return 1;
    return b.updatedAt.localeCompare(a.updatedAt);
  };
  const byTarget = (a: QueueRow, b: QueueRow) => {
    if (a.targetCompletionDate && b.targetCompletionDate) return a.targetCompletionDate.localeCompare(b.targetCompletionDate) || byPending(a, b);
    if (a.targetCompletionDate) return -1;
    if (b.targetCompletionDate) return 1;
    return byPending(a, b);
  };
  return [...rows].sort(sort === 'target_completion' ? byTarget : byPending);
}

export class ConcurrencyError extends Error {
  status = 409;
  constructor() {
    super('The matter changed while this command was running. Retry.');
    this.name = 'ConcurrencyError';
  }
}

// ───────────────────────────── in-memory ─────────────────────────────

export class MemoryEventStore implements EventStore {
  private logs = new Map<string, EngineEvent[]>();
  private states = new Map<string, MatterState>();
  private locks = new Map<string, Promise<unknown>>();
  private slaOverrides = new Map<string, Array<Partial<SlaRule> & { waitKey: WaitKey }>>();
  private subflows = new Map<string, LevelConfig>();
  private reviews: ShadowReview[] = [];
  /** Tests: the levels a tenant starts at (the product default is propose for everything). */
  constructor(private defaultLevels: LevelConfig = DEFAULT_LEVELS) {}
  matterMeta = new Map<string, { matterRef: string | null; propertyAddress: string | null; assignedTo?: string | null }>();

  private key(tenantId: string, matterId: string) {
    return `${tenantId}:${matterId}`;
  }

  async withMatterLock<T>(tenantId: string, matterId: string, fn: (tx: MatterTx) => Promise<T>): Promise<T> {
    const k = this.key(tenantId, matterId);
    // Serialise per matter by chaining onto the previous holder's promise.
    const prev = this.locks.get(k) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    this.locks.set(k, prev.then(() => mine));
    await prev;
    try {
      const log = this.logs.get(k) ?? [];
      const tx: MatterTx = {
        load: async () => [...log],
        append: async (events, expectedLastSeq, now, newId) => {
          const current = this.logs.get(k) ?? [];
          const last = current.length ? current[current.length - 1].seq : 0;
          if (last !== expectedLastSeq) throw new ConcurrencyError();
          const lastHash = current.length ? current[current.length - 1].hash ?? '' : '';
          const staged = events.map((e, i) => ({ ...e, id: newId(), tenantId, matterId, seq: last + i + 1, createdAt: now.toISOString() }) as EngineEvent);
          const out = chainEvents(lastHash, staged) as EngineEvent[];
          this.logs.set(k, [...current, ...out]);
          return out;
        },
        afterAppend: async (state) => {
          this.states.set(k, state);
        },
      };
      return await fn(tx);
    } finally {
      release();
    }
  }

  async listEvents(tenantId: string, matterId: string, opts?: { afterSeq?: number; limit?: number }): Promise<EngineEvent[]> {
    const all = (this.logs.get(this.key(tenantId, matterId)) ?? []).filter((e) => e.seq > (opts?.afterSeq ?? 0));
    return opts?.limit ? all.slice(0, opts.limit) : all;
  }

  async listActiveMatters(tenantId?: string | null): Promise<EnrolledMatter[]> {
    const out: EnrolledMatter[] = [];
    for (const [k, s] of this.states) {
      if (tenantId && !k.startsWith(`${tenantId}:`)) continue;
      if (!s.enrolled || s.postCompletion.ap1ConfirmedAt || s.abandoned) continue;
      out.push({ tenantId: s.tenantId, matterId: s.matterId, stage: s.stage });
    }
    return out;
  }

  async listPendingDecisions(tenantId: string, opts?: { matterId?: string | null; limit?: number; includeShadow?: boolean }): Promise<PendingDecisionRow[]> {
    const cfg = await this.loadLevels(tenantId);
    const rows: PendingDecisionRow[] = [];
    for (const s of this.states.values()) {
      if (s.tenantId !== tenantId) continue;
      if (opts?.matterId && s.matterId !== opts.matterId) continue;
      const meta = this.matterMeta.get(this.key(s.tenantId, s.matterId));
      const list = surfacedDecisions(s);
      for (const d of list) rows.push(row(s, d, meta));
    }
    rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.seq - b.seq);
    return opts?.limit ? rows.slice(0, opts.limit) : rows;
  }

  async findDecision(tenantId: string, eventId: string): Promise<PendingDecisionRow | null> {
    for (const s of this.states.values()) {
      if (s.tenantId !== tenantId) continue;
      const d = s.decisions[eventId];
      if (d) return row(s, d, this.matterMeta.get(this.key(s.tenantId, s.matterId)));
    }
    return null;
  }

  async loadLevels(tenantId: string): Promise<LevelConfig> {
    return { ...this.defaultLevels, ...(this.subflows.get(tenantId) ?? {}) };
  }

  async setLevel(tenantId: string, key: string, level: TrustLevel, _userId: string | null = null): Promise<LevelConfig> {
    const cur = { ...(await this.loadLevels(tenantId)) };
    if (!key.includes(':')) for (const k of Object.keys(cur)) if (k.startsWith(`${key}:`)) delete cur[k];
    this.subflows.set(tenantId, { ...cur, [key]: level });
    return this.loadLevels(tenantId);
  }

  /** Every enrolled matter this view should consider, with its meta. */
  private matching(tenantId: string, opts?: QueueOptions): Array<{ state: MatterState; meta: { matterRef: string | null; propertyAddress: string | null; assignedTo: string | null } }> {
    const out: Array<{ state: MatterState; meta: { matterRef: string | null; propertyAddress: string | null; assignedTo: string | null } }> = [];
    for (const s of this.states.values()) {
      if (s.tenantId !== tenantId || !s.enrolled) continue;
      if (!opts?.includeFinished && (s.closedAt || s.abandoned)) continue;
      const meta = this.matterMeta.get(this.key(s.tenantId, s.matterId));
      if (opts?.assignedTo && meta?.assignedTo !== opts.assignedTo) continue;
      out.push({ state: s, meta: { matterRef: meta?.matterRef ?? null, propertyAddress: meta?.propertyAddress ?? null, assignedTo: meta?.assignedTo ?? null } });
    }
    return out;
  }

  async listQueue(tenantId: string, opts?: QueueOptions): Promise<QueueRow[]> {
    const cfg = await this.loadLevels(tenantId);
    const rows = this.matching(tenantId, opts).map(({ state, meta }) => queueRow(state, meta, cfg));
    const sorted = sortQueue(rows, opts?.sort);
    return opts?.limit ? sorted.slice(0, opts.limit) : sorted;
  }

  async listStates(tenantId: string, opts?: QueueOptions): Promise<Array<{ state: MatterState; meta: { matterRef: string | null; propertyAddress: string | null; assignedTo: string | null } }>> {
    const all = this.matching(tenantId, opts);
    return opts?.limit ? all.slice(0, opts.limit) : all;
  }

  async listShadowReviews(tenantId: string, matterId?: string | null): Promise<ShadowReview[]> {
    return this.reviews.filter((r) => r.tenantId === tenantId && (!matterId || r.matterId === matterId));
  }

  async recordShadowReview(input: Omit<ShadowReview, 'id' | 'createdAt'>): Promise<ShadowReview> {
    const existing = this.reviews.findIndex((r) => r.eventId === input.eventId && r.reviewer === input.reviewer);
    const rec: ShadowReview = { ...input, id: existing >= 0 ? this.reviews[existing].id : `sr-${this.reviews.length + 1}`, createdAt: new Date().toISOString() };
    if (existing >= 0) this.reviews[existing] = rec;
    else this.reviews.push(rec);
    return rec;
  }

  async cachedState(tenantId: string, matterId: string): Promise<MatterState | null> {
    return this.states.get(this.key(tenantId, matterId)) ?? null;
  }

  setSlaOverrides(tenantId: string, overrides: Array<Partial<SlaRule> & { waitKey: WaitKey }>): void {
    this.slaOverrides.set(tenantId, overrides);
  }

  async loadSla(tenantId: string): Promise<SlaConfig> {
    return withOverrides(this.slaOverrides.get(tenantId) ?? [], DEFAULT_SLA);
  }

  /** Test helper: the raw log. */
  dump(tenantId: string, matterId: string): EngineEvent[] {
    return [...(this.logs.get(this.key(tenantId, matterId)) ?? [])];
  }
}

// ───────────────────────────── Postgres ─────────────────────────────

interface EventRow {
  id: string;
  tenant_id: string;
  matter_id: string;
  seq: number | string;
  type: EngineEvent['type'];
  actor: string;
  payload: unknown;
  source_document_id: string | null;
  confidence_score: number | string | null;
  caused_by_event_id: string | null;
  created_at: Date | string;
  prev_hash?: string | null;
  hash?: string | null;
}

const rowToEvent = (r: EventRow): EngineEvent =>
  ({
    id: r.id,
    tenantId: r.tenant_id,
    matterId: r.matter_id,
    seq: Number(r.seq),
    type: r.type,
    actor: r.actor,
    payload: r.payload,
    sourceDocumentId: r.source_document_id,
    confidenceScore: r.confidence_score === null ? null : Number(r.confidence_score),
    causedByEventId: r.caused_by_event_id,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : new Date(r.created_at).toISOString(),
    prevHash: r.prev_hash ?? undefined,
    hash: r.hash ?? undefined,
  }) as EngineEvent;

const EVENT_COLS = 'id, tenant_id, matter_id, seq, type, actor, payload, source_document_id, confidence_score, caused_by_event_id, created_at, prev_hash, hash';

interface PgDecisionRow {
  decision: DecisionState;
  tenant_id: string;
  matter_id: string;
  assigned_to?: string | null;
  matter_ref: string | null;
  property_address: string | null;
  stage: string;
  shadow_mode: boolean | null;
}
const pgDecisionRow = (r: PgDecisionRow): PendingDecisionRow => ({ ...r.decision, tenantId: r.tenant_id, matterId: r.matter_id, matterRef: r.matter_ref, propertyAddress: r.property_address, assignedTo: r.assigned_to ?? null, stage: r.stage, shadowMode: !!r.shadow_mode });

export class PgEventStore implements EventStore {
  async withMatterLock<T>(tenantId: string, matterId: string, fn: (tx: MatterTx) => Promise<T>): Promise<T> {
    return dbTransaction(async (client) => {
      // One writer per matter for the duration of the transaction.
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [`engine:${matterId}`]);
      const tx: MatterTx = {
        load: async () => {
          const r = await client.query<EventRow>(`select ${EVENT_COLS} from matter_event where tenant_id = $1 and matter_id = $2 order by seq`, [tenantId, matterId]);
          return r.rows.map(rowToEvent);
        },
        append: async (events, expectedLastSeq, now, newId) => {
          const last = await client.query<{ n: string | null; hash: string | null }>(
            `select max(seq)::text as n, (select hash from matter_event where tenant_id = $1 and matter_id = $2 order by seq desc limit 1) as hash
               from matter_event where tenant_id = $1 and matter_id = $2`,
            [tenantId, matterId]
          );
          const lastSeq = Number(last.rows[0]?.n ?? 0);
          if (lastSeq !== expectedLastSeq) throw new ConcurrencyError();
          const createdAt = now.toISOString();
          const staged = events.map((e, i) => ({ ...e, id: newId(), tenantId, matterId, seq: lastSeq + i + 1, createdAt }) as EngineEvent);
          const chained = chainEvents(last.rows[0]?.hash ?? '', staged) as EngineEvent[];
          const out: EngineEvent[] = [];
          for (const e of chained) {
            const r = await client.query<EventRow>(
              `insert into matter_event (id, tenant_id, matter_id, seq, type, actor, payload, source_document_id, confidence_score, caused_by_event_id, created_at, prev_hash, hash)
               values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13) returning ${EVENT_COLS}`,
              [e.id, tenantId, matterId, e.seq, e.type, e.actor, JSON.stringify(e.payload), e.sourceDocumentId ?? null, e.confidenceScore ?? null, e.causedByEventId ?? null, e.createdAt, e.prevHash ?? '', e.hash ?? '']
            );
            out.push(rowToEvent(r.rows[0]));
          }
          return out;
        },
        afterAppend: async (state, appended) => refreshReadModels(client, state, appended),
      };
      return fn(tx);
    });
  }

  async listEvents(tenantId: string, matterId: string, opts?: { afterSeq?: number; limit?: number }): Promise<EngineEvent[]> {
    const rows = await dbQuery<EventRow>(
      `select ${EVENT_COLS} from matter_event where tenant_id = $1 and matter_id = $2 and seq > $3 order by seq limit $4`,
      [tenantId, matterId, opts?.afterSeq ?? 0, opts?.limit ?? 10_000]
    );
    return rows.map(rowToEvent);
  }

  async listActiveMatters(tenantId?: string | null): Promise<EnrolledMatter[]> {
    return dbQuery<EnrolledMatter>(
      `select tenant_id as "tenantId", matter_id as "matterId", stage
         from matter_engine_state
        where ($1::uuid is null or tenant_id = $1::uuid) and finished_at is null
        order by updated_at asc`,
      [tenantId ?? null]
    );
  }

  async listPendingDecisions(tenantId: string, opts?: { matterId?: string | null; limit?: number; includeShadow?: boolean }): Promise<PendingDecisionRow[]> {
    const hiddenKinds: string[] = [];
    const rows = await dbQuery<PgDecisionRow>(
      `select d.decision, d.tenant_id, d.matter_id, m.matter_ref, m.property_address, m.assigned_to, s.stage, coalesce((s.state->>'shadowMode')::boolean, m.shadow_mode, false) as shadow_mode
         from matter_decision d
         join matter m on m.id = d.matter_id
         left join matter_engine_state s on s.matter_id = d.matter_id
        where d.tenant_id = $1 and d.status = 'pending' and ($2::uuid is null or d.matter_id = $2::uuid)
          and ($4::boolean or true)
          and not (d.kind = any($5::text[]))
        order by d.created_at asc limit $3`,
      [tenantId, opts?.matterId ?? null, opts?.limit ?? 200, !!opts?.includeShadow, hiddenKinds]
    );
    return rows.map(pgDecisionRow);
  }

  async findDecision(tenantId: string, eventId: string): Promise<PendingDecisionRow | null> {
    const r = await dbQuery<PgDecisionRow>(
      `select d.decision, d.tenant_id, d.matter_id, m.matter_ref, m.property_address, s.stage, coalesce((s.state->>'shadowMode')::boolean, m.shadow_mode, false) as shadow_mode
         from matter_decision d
         join matter m on m.id = d.matter_id
         left join matter_engine_state s on s.matter_id = d.matter_id
        where d.tenant_id = $1 and d.event_id = $2`,
      [tenantId, eventId]
    );
    return r[0] ? pgDecisionRow(r[0]) : null;
  }

  async loadLevels(tenantId: string): Promise<LevelConfig> {
    const rows = await dbQuery<{ action: string; level: TrustLevel }>(`select action, level from engine_action_level where tenant_id = $1`, [tenantId]).catch(() => []);
    const cfg: LevelConfig = { ...DEFAULT_LEVELS };
    for (const r of rows) if ((ENGINE_ACTIONS as readonly string[]).includes(r.action.split(':')[0]) && (TRUST_LEVELS as readonly string[]).includes(r.level)) cfg[r.action] = r.level;
    return cfg;
  }

  async setLevel(tenantId: string, key: string, level: TrustLevel, userId: string | null): Promise<LevelConfig> {
    await dbQuery(
      `insert into engine_action_level (tenant_id, action, level, updated_by, updated_at) values ($1,$2,$3,$4,now())
       on conflict (tenant_id, action) do update set level = excluded.level, updated_by = excluded.updated_by, updated_at = now()`,
      [tenantId, key, level, userId]
    );
    // Setting an action's level clears its subjects' overrides: the action now speaks for all of them.
    if (!key.includes(':')) await dbQuery(`delete from engine_action_level where tenant_id = $1 and action like $2`, [tenantId, `${key}:%`]);
    return this.loadLevels(tenantId);
  }

  private async queueRows(tenantId: string, opts?: QueueOptions) {
    return dbQuery<{ state: MatterState; matter_ref: string | null; property_address: string | null; assigned_to: string | null; updated_at: Date | string }>(
      `select s.state, m.matter_ref, m.property_address, m.assigned_to, s.updated_at
         from matter_engine_state s
         join matter m on m.id = s.matter_id
        where s.tenant_id = $1 and ($5::boolean or s.finished_at is null)
          and ($2::uuid is null or m.assigned_to = $2::uuid)
          and ($3::boolean or coalesce((s.state->>'shadowMode')::boolean, m.shadow_mode, false) = false)
        order by s.updated_at desc limit $4`,
      [tenantId, opts?.assignedTo ?? null, !!opts?.includeShadow, opts?.limit ?? 500, !!opts?.includeFinished]
    );
  }

  async listStates(tenantId: string, opts?: QueueOptions): Promise<Array<{ state: MatterState; meta: { matterRef: string | null; propertyAddress: string | null; assignedTo: string | null } }>> {
    const rows = await this.queueRows(tenantId, opts);
    return rows.map((r) => ({ state: withStateDefaults(r.state), meta: { matterRef: r.matter_ref, propertyAddress: r.property_address, assignedTo: r.assigned_to } }));
  }

  async listQueue(tenantId: string, opts?: QueueOptions): Promise<QueueRow[]> {
    const cfg = await this.loadLevels(tenantId);
    const rows = await this.queueRows(tenantId, opts);
    return sortQueue(
      rows.map((r) => queueRow(withStateDefaults(r.state), { matterRef: r.matter_ref, propertyAddress: r.property_address, assignedTo: r.assigned_to, updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : new Date(r.updated_at).toISOString() }, cfg)),
      opts?.sort
    );
  }

  async listShadowReviews(tenantId: string, matterId?: string | null): Promise<ShadowReview[]> {
    const rows = await dbQuery<{ id: string; tenant_id: string; matter_id: string; event_id: string; sub_flow: string; agrees: boolean; human_outcome: string | null; note: string | null; reviewer: string; created_at: Date | string }>(
      `select id, tenant_id, matter_id, event_id, sub_flow, agrees, human_outcome, note, reviewer, created_at from engine_shadow_review
        where tenant_id = $1 and ($2::uuid is null or matter_id = $2::uuid) order by created_at desc`,
      [tenantId, matterId ?? null]
    );
    return rows.map((r) => ({ id: r.id, tenantId: r.tenant_id, matterId: r.matter_id, eventId: r.event_id, subFlow: r.sub_flow, agrees: r.agrees, humanOutcome: r.human_outcome, note: r.note, reviewer: r.reviewer, createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : new Date(r.created_at).toISOString() }));
  }

  async recordShadowReview(input: Omit<ShadowReview, 'id' | 'createdAt'>): Promise<ShadowReview> {
    const r = await dbQuery<{ id: string; created_at: Date | string }>(
      `insert into engine_shadow_review (tenant_id, matter_id, event_id, sub_flow, agrees, human_outcome, note, reviewer)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (event_id, reviewer) do update set agrees = excluded.agrees, human_outcome = excluded.human_outcome, note = excluded.note, created_at = now()
       returning id, created_at`,
      [input.tenantId, input.matterId, input.eventId, input.subFlow, input.agrees, input.humanOutcome, input.note, input.reviewer]
    );
    return { ...input, id: r[0].id, createdAt: r[0].created_at instanceof Date ? r[0].created_at.toISOString() : new Date(r[0].created_at).toISOString() };
  }

  async cachedState(tenantId: string, matterId: string): Promise<MatterState | null> {
    const r = await dbQuery<{ state: MatterState }>(`select state from matter_engine_state where tenant_id = $1 and matter_id = $2`, [tenantId, matterId]);
    return r[0] ? withStateDefaults(r[0].state) : null;
  }

  async loadSla(tenantId: string): Promise<SlaConfig> {
    const rows = await dbQuery<{ wait_key: WaitKey; chase_after: number | null; chase_every: number | null; escalate_after: number | null; re_escalate_after: number | null }>(
      `select wait_key, chase_after, chase_every, escalate_after, re_escalate_after from engine_sla_override where tenant_id = $1`,
      [tenantId]
    ).catch(() => []);
    return withOverrides(
      rows.map((r) => ({
        waitKey: r.wait_key,
        chaseAfter: r.chase_after ?? undefined,
        chaseEvery: r.chase_every === null ? undefined : r.chase_every,
        escalateAfter: r.escalate_after ?? undefined,
        reEscalateAfter: r.re_escalate_after ?? undefined,
      })),
      DEFAULT_SLA
    );
  }
}

/**
 * A best-effort statement inside a transaction. A plain `.catch(() => {})` is a trap in
 * Postgres: the failed statement leaves the transaction aborted, every later statement
 * fails, and the final COMMIT quietly becomes a ROLLBACK — the event append itself is
 * lost with no error anywhere. A savepoint confines the failure to this one statement.
 */
async function bestEffort(client: pg.PoolClient, name: string, fn: () => Promise<unknown>): Promise<void> {
  await client.query(`savepoint ${name}`);
  try {
    await fn();
    await client.query(`release savepoint ${name}`);
  } catch {
    await client.query(`rollback to savepoint ${name}`);
  }
}

/** Rebuild the read models for one matter from the projected state (idempotent). */
async function refreshReadModels(client: pg.PoolClient, state: MatterState, appended: EngineEvent[]): Promise<void> {
  await client.query(
    `insert into matter_engine_state (tenant_id, matter_id, stage, last_seq, state, finished_at, updated_at)
     values ($1,$2,$3,$4,$5::jsonb,$6,now())
     on conflict (matter_id) do update set stage = excluded.stage, last_seq = excluded.last_seq, state = excluded.state, finished_at = excluded.finished_at, updated_at = now()`,
    [state.tenantId, state.matterId, state.stage, state.lastSeq, JSON.stringify(state), state.postCompletion.ap1ConfirmedAt ?? state.abandoned?.at ?? null]
  );
  for (const d of Object.values(state.decisions)) {
    await client.query(
      `insert into matter_decision (event_id, tenant_id, matter_id, kind, status, summary, source_document_id, options, resolved_by, resolved_at, resolution, decision, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12::jsonb,$13)
       on conflict (event_id) do update set status = excluded.status, resolved_by = excluded.resolved_by, resolved_at = excluded.resolved_at, resolution = excluded.resolution, decision = excluded.decision`,
      [d.eventId, state.tenantId, state.matterId, d.kind, d.status, d.summary, d.sourceDocumentId, JSON.stringify(d.options), d.resolvedBy, d.resolvedAt, d.resolution, JSON.stringify(d), d.createdAt]
    );
  }
  // Addendum 2: the versioned PayeeBankDetails read model. Insert-only; only status +
  // verification columns may change (the table's trigger enforces that too).
  for (const b of Object.values(state.bankDetails)) {
    await bestEffort(client, 'bank', () =>
      client.query(
        `insert into payee_bank_details (id, tenant_id, matter_id, payee_kind, payee_ref, sort_code, account_number, account_name, firm_name, source_channel, source_document_id, supersedes_id, status, recorded_by, verified_at, verified_by, verification_method, verification_ref, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         on conflict (id) do update set status = excluded.status,
           verified_at = coalesce(payee_bank_details.verified_at, excluded.verified_at),
           verified_by = coalesce(payee_bank_details.verified_by, excluded.verified_by),
           verification_method = coalesce(payee_bank_details.verification_method, excluded.verification_method),
           verification_ref = coalesce(payee_bank_details.verification_ref, excluded.verification_ref)`,
        [b.id, state.tenantId, state.matterId, b.payeeKind, b.payeeRef, b.details.sortCode, b.details.accountNumber, b.details.accountName, b.details.firmName, b.sourceChannel, b.sourceDocumentId || null, b.supersedesId, b.status, b.recordedBy, b.verifiedAt, b.verifiedBy, b.verificationMethod, b.verificationRef, b.recordedAt]
      )
    );
  }
  // Addendum 3 §2: keep matter.shadow_mode in step with the log (it is queryable without projecting).
  if (appended.some((e) => e.type === 'matter_created' || e.type === 'shadow_mode_changed')) {
    await bestEffort(client, 'shadow', () => client.query(`update matter set shadow_mode = $1 where id = $2 and tenant_id = $3`, [state.shadowMode, state.matterId, state.tenantId]));
  }
  // Mirror stage moves onto the legacy board (forward-only) + the drawer's Activity tab.
  // NOT in shadow mode: the engine's stage is its conclusion; the human's record stays theirs
  // (that gap is exactly what the comparison view shows).
  for (const e of appended) {
    if (state.shadowMode) break;
    if (e.type !== 'stage_advanced' && e.type !== 'matter_created') continue;
    const legacy = LEGACY_STAGE[state.stage];
    await bestEffort(client, 'stage', () =>
      client.query(
        `update matter set stage = $1, stage_entered_at = now(), updated_at = now(), transaction_type = coalesce(transaction_type, 'freehold_purchase')
          where id = $2 and tenant_id = $3 and coalesce(array_position($4::text[], stage), 0) < array_position($4::text[], $1)`,
        [legacy, state.matterId, state.tenantId, LEGACY_ORDER]
      )
    );
    if (e.type === 'stage_advanced') {
      const p = e.payload as { from: string; to: string; reason: string };
      await bestEffort(client, 'timeline', () =>
        client.query(
          `insert into matter_timeline_event (tenant_id, matter_id, event_at, event_type, title, details, source_ref)
           values ($1,$2,now(),'ENGINE_STAGE_ADVANCED',$3,$4,$5::jsonb)`,
          [state.tenantId, state.matterId, `Engine: ${p.from.replace(/_/g, ' ')} → ${p.to.replace(/_/g, ' ')}`, p.reason, JSON.stringify({ eventId: e.id, seq: e.seq })]
        )
      );
    }
  }
}

const LEGACY_ORDER = ['INSTRUCTION', 'CONTRACT_PACK', 'SEARCHES_ENQUIRIES', 'REVIEW_SIGNING', 'EXCHANGE', 'COMPLETION', 'POST_COMPLETION'];

/** Rebuild a matter's state purely from its log — the audit test, runnable in prod. */
export async function replay(store: EventStore, tenantId: string, matterId: string): Promise<MatterState> {
  return project(tenantId, matterId, await store.listEvents(tenantId, matterId));
}

export { STAGES };
