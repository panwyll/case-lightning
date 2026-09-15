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
import { DEFAULT_SLA, withOverrides, type SlaConfig, type SlaRule } from './sla';
import { LEGACY_STAGE, STAGES, type DecisionState, type EngineEvent, type MatterState, type NewEvent, type WaitKey } from './types';

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
  stage: string;
}

export interface EventStore {
  withMatterLock<T>(tenantId: string, matterId: string, fn: (tx: MatterTx) => Promise<T>): Promise<T>;
  listEvents(tenantId: string, matterId: string, opts?: { afterSeq?: number; limit?: number }): Promise<EngineEvent[]>;
  /** Matters the timer sweep should visit (enrolled and not finished). */
  listActiveMatters(tenantId?: string | null): Promise<EnrolledMatter[]>;
  listPendingDecisions(tenantId: string, opts?: { matterId?: string | null; limit?: number }): Promise<PendingDecisionRow[]>;
  /** Any decision (pending or not) by its event id — the dashboard's detail/resolve routes need the matter it belongs to. */
  findDecision(tenantId: string, eventId: string): Promise<PendingDecisionRow | null>;
  loadSla(tenantId: string): Promise<SlaConfig>;
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
  matterMeta = new Map<string, { matterRef: string | null; propertyAddress: string | null }>();

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
          const out: EngineEvent[] = events.map((e, i) => ({ ...e, id: newId(), tenantId, matterId, seq: last + i + 1, createdAt: now.toISOString() }) as EngineEvent);
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
      if (!s.enrolled || s.postCompletion.ap1ConfirmedAt) continue;
      out.push({ tenantId: s.tenantId, matterId: s.matterId, stage: s.stage });
    }
    return out;
  }

  async listPendingDecisions(tenantId: string, opts?: { matterId?: string | null; limit?: number }): Promise<PendingDecisionRow[]> {
    const rows: PendingDecisionRow[] = [];
    for (const s of this.states.values()) {
      if (s.tenantId !== tenantId) continue;
      if (opts?.matterId && s.matterId !== opts.matterId) continue;
      const meta = this.matterMeta.get(this.key(s.tenantId, s.matterId));
      for (const d of Object.values(s.decisions)) {
        if (d.status === 'pending') rows.push({ ...d, tenantId: s.tenantId, matterId: s.matterId, matterRef: meta?.matterRef ?? null, propertyAddress: meta?.propertyAddress ?? null, stage: s.stage });
      }
    }
    rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.seq - b.seq);
    return opts?.limit ? rows.slice(0, opts.limit) : rows;
  }

  async findDecision(tenantId: string, eventId: string): Promise<PendingDecisionRow | null> {
    for (const s of this.states.values()) {
      if (s.tenantId !== tenantId) continue;
      const d = s.decisions[eventId];
      if (d) {
        const meta = this.matterMeta.get(this.key(s.tenantId, s.matterId));
        return { ...d, tenantId: s.tenantId, matterId: s.matterId, matterRef: meta?.matterRef ?? null, propertyAddress: meta?.propertyAddress ?? null, stage: s.stage };
      }
    }
    return null;
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
  }) as EngineEvent;

const EVENT_COLS = 'id, tenant_id, matter_id, seq, type, actor, payload, source_document_id, confidence_score, caused_by_event_id, created_at';

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
          const last = await client.query<{ n: string | null }>(`select max(seq)::text as n from matter_event where tenant_id = $1 and matter_id = $2`, [tenantId, matterId]);
          const lastSeq = Number(last.rows[0]?.n ?? 0);
          if (lastSeq !== expectedLastSeq) throw new ConcurrencyError();
          const out: EngineEvent[] = [];
          for (let i = 0; i < events.length; i++) {
            const e = events[i];
            const r = await client.query<EventRow>(
              `insert into matter_event (id, tenant_id, matter_id, seq, type, actor, payload, source_document_id, confidence_score, caused_by_event_id, created_at)
               values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11) returning ${EVENT_COLS}`,
              [newId(), tenantId, matterId, lastSeq + i + 1, e.type, e.actor, JSON.stringify(e.payload), e.sourceDocumentId ?? null, e.confidenceScore ?? null, e.causedByEventId ?? null, now.toISOString()]
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

  async listPendingDecisions(tenantId: string, opts?: { matterId?: string | null; limit?: number }): Promise<PendingDecisionRow[]> {
    const rows = await dbQuery<{ decision: DecisionState; tenant_id: string; matter_id: string; matter_ref: string | null; property_address: string | null; stage: string }>(
      `select d.decision, d.tenant_id, d.matter_id, m.matter_ref, m.property_address, s.stage
         from matter_decision d
         join matter m on m.id = d.matter_id
         left join matter_engine_state s on s.matter_id = d.matter_id
        where d.tenant_id = $1 and d.status = 'pending' and ($2::uuid is null or d.matter_id = $2::uuid)
        order by d.created_at asc limit $3`,
      [tenantId, opts?.matterId ?? null, opts?.limit ?? 200]
    );
    return rows.map((r) => ({ ...r.decision, tenantId: r.tenant_id, matterId: r.matter_id, matterRef: r.matter_ref, propertyAddress: r.property_address, stage: r.stage }));
  }

  async findDecision(tenantId: string, eventId: string): Promise<PendingDecisionRow | null> {
    const r = await dbQuery<{ decision: DecisionState; tenant_id: string; matter_id: string; matter_ref: string | null; property_address: string | null; stage: string }>(
      `select d.decision, d.tenant_id, d.matter_id, m.matter_ref, m.property_address, s.stage
         from matter_decision d
         join matter m on m.id = d.matter_id
         left join matter_engine_state s on s.matter_id = d.matter_id
        where d.tenant_id = $1 and d.event_id = $2`,
      [tenantId, eventId]
    );
    const row = r[0];
    return row ? { ...row.decision, tenantId: row.tenant_id, matterId: row.matter_id, matterRef: row.matter_ref, propertyAddress: row.property_address, stage: row.stage } : null;
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

/** Rebuild the read models for one matter from the projected state (idempotent). */
async function refreshReadModels(client: pg.PoolClient, state: MatterState, appended: EngineEvent[]): Promise<void> {
  await client.query(
    `insert into matter_engine_state (tenant_id, matter_id, stage, last_seq, state, finished_at, updated_at)
     values ($1,$2,$3,$4,$5::jsonb,$6,now())
     on conflict (matter_id) do update set stage = excluded.stage, last_seq = excluded.last_seq, state = excluded.state, finished_at = excluded.finished_at, updated_at = now()`,
    [state.tenantId, state.matterId, state.stage, state.lastSeq, JSON.stringify(state), state.postCompletion.ap1ConfirmedAt]
  );
  for (const d of Object.values(state.decisions)) {
    await client.query(
      `insert into matter_decision (event_id, tenant_id, matter_id, kind, status, summary, source_document_id, options, resolved_by, resolved_at, resolution, decision, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12::jsonb,$13)
       on conflict (event_id) do update set status = excluded.status, resolved_by = excluded.resolved_by, resolved_at = excluded.resolved_at, resolution = excluded.resolution, decision = excluded.decision`,
      [d.eventId, state.tenantId, state.matterId, d.kind, d.status, d.summary, d.sourceDocumentId, JSON.stringify(d.options), d.resolvedBy, d.resolvedAt, d.resolution, JSON.stringify(d), d.createdAt]
    );
  }
  // Mirror stage moves onto the legacy board (forward-only) + the drawer's Activity tab.
  for (const e of appended) {
    if (e.type !== 'stage_advanced' && e.type !== 'matter_created') continue;
    const legacy = LEGACY_STAGE[state.stage];
    await client
      .query(
        `update matter set stage = $1, stage_entered_at = now(), updated_at = now(), transaction_type = coalesce(transaction_type, 'freehold_purchase')
          where id = $2 and tenant_id = $3 and coalesce(array_position($4::text[], stage), 0) < array_position($4::text[], $1)`,
        [legacy, state.matterId, state.tenantId, LEGACY_ORDER]
      )
      .catch(() => {});
    if (e.type === 'stage_advanced') {
      const p = e.payload as { from: string; to: string; reason: string };
      await client
        .query(
          `insert into matter_timeline_event (tenant_id, matter_id, event_at, event_type, title, details, source_ref)
           values ($1,$2,now(),'ENGINE_STAGE_ADVANCED',$3,$4,$5::jsonb)`,
          [state.tenantId, state.matterId, `Engine: ${p.from.replace(/_/g, ' ')} → ${p.to.replace(/_/g, ' ')}`, p.reason, JSON.stringify({ eventId: e.id, seq: e.seq })]
        )
        .catch(() => {});
    }
  }
}

const LEGACY_ORDER = ['INSTRUCTION', 'CONTRACT_PACK', 'SEARCHES_ENQUIRIES', 'REVIEW_SIGNING', 'EXCHANGE', 'COMPLETION', 'POST_COMPLETION'];

/** Rebuild a matter's state purely from its log — the audit test, runnable in prod. */
export async function replay(store: EventStore, tenantId: string, matterId: string): Promise<MatterState> {
  return project(tenantId, matterId, await store.listEvents(tenantId, matterId));
}

export { STAGES };
