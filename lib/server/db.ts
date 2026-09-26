/**
 * Raw Postgres access against Supabase (via DATABASE_URL / connection pooler).
 *
 * We use `pg` directly rather than supabase-js because the RAG retrieval path needs
 * the pgvector `<=>` operator, which supabase-js cannot express without an RPC.
 * The pool is created lazily so importing this module never crashes a build when
 * DATABASE_URL is absent (the marketing site must keep deploying).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import { config } from './config';

/**
 * Who is asking. Row-level security (migration 068, the ethical wall between handlers
 * of internally-linked matters) reads `app.user_id`, which we set with
 * set_config(..., true) INSIDE a transaction around every query made on behalf of a
 * signed-in user. Bound once per request by session.ts; the engine's own effects,
 * cron and webhooks run without a user and are not walled (the wall is between people).
 */
const dbUser = new AsyncLocalStorage<{ userId: string | null }>();

/**
 * Addendum 3 §1: automation contexts (cron, webhooks, ingestion, the engine's own
 * post-commit effects — anything not a human request) run their statements under the
 * NOLOGIN role conveyi_automation via SET LOCAL ROLE. A restrictive policy (migration
 * 071) denies that role the human-gated event types outright, so no automated or
 * AI-driven code path can write a payment or an outbound-AI-content event, whatever
 * the application code does. Human request pathways stay on the app role.
 */
const dbAutomation = new AsyncLocalStorage<{ automation: boolean }>();
let automationRoleAvailable: boolean | null = null;

export function runAsAutomation<T>(fn: () => Promise<T>): Promise<T> {
  return dbAutomation.run({ automation: true }, fn);
}

export function inAutomationContext(): boolean {
  return dbAutomation.getStore()?.automation === true;
}

/**
 * Request-scoped fallback. `AsyncLocalStorage.enterWith` inside an awaited function does
 * not reach the caller's continuation, so a route that merely awaits requireUser() would
 * otherwise run its queries WITHOUT the user bound — and the wall would silently not
 * apply over HTTP. session.ts registers a resolver that reads the request's session
 * cookie / bearer token; db.ts consults it whenever no explicit runAsUser/runAsSystem
 * scope is active. Outside a request (cron, scripts) the resolver returns null → system.
 */
let requestUserResolver: (() => Promise<string | null>) | null = null;
export function registerRequestUserResolver(fn: () => Promise<string | null>): void {
  requestUserResolver = fn;
}

async function effectiveDbUser(): Promise<string | null> {
  const scoped = dbUser.getStore();
  if (scoped) return scoped.userId; // explicit runAsUser / runAsSystem / bindDbUser wins
  if (!requestUserResolver) return null;
  try {
    return await requestUserResolver();
  } catch {
    return null;
  }
}

/** Bind the current async context to a user (session.ts calls this after loading the session). */
export function bindDbUser(userId: string | null): void {
  dbUser.enterWith({ userId });
}

/** Run `fn` explicitly as the system (no user): the sanctioned way to read across the wall for non-confidential lookups. */
export function runAsSystem<T>(fn: () => Promise<T>): Promise<T> {
  return dbUser.run({ userId: null }, fn);
}

export function runAsUser<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  return dbUser.run({ userId }, fn);
}

export function currentDbUser(): string | null {
  return dbUser.getStore()?.userId ?? null;
}

const { Pool } = pg;
type QueryResultRow = pg.QueryResultRow;

let _pool: pg.Pool | null = null;

export function pool(): pg.Pool {
  if (!_pool) {
    if (!config.databaseUrl) {
      throw new Error('DATABASE_URL is not set; database features are unavailable.');
    }
    const raw = config.databaseUrl;
    const isLocal = raw.includes('localhost') || raw.includes('127.0.0.1');

    // Strip any `sslmode` from the connection string — otherwise pg honours it
    // and our explicit `ssl` option below is ignored, so Supabase's pooler cert
    // (a chain Node treats as self-signed) gets rejected. We do TLS without
    // chain verification instead, which is correct for the Supabase pooler.
    let connectionString = raw;
    try {
      const u = new URL(raw);
      u.searchParams.delete('sslmode');
      connectionString = u.toString();
    } catch {
      /* not URL-parseable; use as-is */
    }

    _pool = new Pool({
      connectionString,
      ssl: isLocal ? false : { rejectUnauthorized: false },
      max: 5,
    });
  }
  return _pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values: unknown[] = []
): Promise<T[]> {
  const user = await effectiveDbUser();
  if (!user && !inAutomationContext()) {
    const result = await pool().query<T>(text, values);
    return result.rows;
  }
  if (!user) return transaction(async (client) => (await client.query<T>(text, values)).rows);
  // A user is bound: run inside a transaction so set_config(..., is_local = true)
  // scopes app.user_id to this statement and never leaks to the next pool borrower.
  return runAsUser(user, () => transaction(async (client) => (await client.query<T>(text, values)).rows));
}

export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values: unknown[] = []
): Promise<T | null> {
  const rows = await query<T>(text, values);
  return rows[0] ?? null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Every statement with a user bound runs in its own transaction so the binding never
 * leaks to the next pool borrower. That is the right isolation — but done naively it is
 * four round trips per query (begin, set_config, the query, commit), and from a Vercel
 * function to a database in another region each trip is ~100 ms. So the whole setup —
 * begin, the user binding, the role switch — goes to the server as ONE simple-protocol
 * message, and the query and commit follow: three trips, not four or five.
 *
 * The user id is only ever inlined after it has matched the UUID pattern; anything else
 * takes the parameterised path. Nothing unvalidated is ever spliced into SQL.
 */
export async function transaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    const user = await effectiveDbUser();
    const automation = inAutomationContext();
    if (automation && automationRoleAvailable === null) {
      // Probed once per process, outside any transaction.
      const r = await client.query<{ ok: boolean }>(`select pg_has_role(current_user, 'conveyi_automation', 'member') as ok`).catch(() => ({ rows: [{ ok: false }] }));
      automationRoleAvailable = !!r.rows[0]?.ok;
    }
    const setup = ['begin'];
    const inlineUser = user && UUID.test(user) ? user : null;
    if (inlineUser) setup.push(`select set_config('app.user_id', '${inlineUser}', true)`);
    if (automation && automationRoleAvailable) setup.push('set local role conveyi_automation');
    await client.query(setup.join('; '));
    if (user && !inlineUser) await client.query(`select set_config('app.user_id', $1, true)`, [user]);
    const value = await work(client);
    // COMMIT on an aborted transaction does not error: Postgres answers ROLLBACK. Say so,
    // or a swallowed failure earlier in `work` silently loses every write in it.
    const done = await client.query('commit');
    if (done.command === 'ROLLBACK') throw new Error('Transaction was aborted by an earlier statement and rolled back.');
    return value;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
