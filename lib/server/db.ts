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
  const user = currentDbUser();
  if (!user) {
    const result = await pool().query<T>(text, values);
    return result.rows;
  }
  // A user is bound: run inside a transaction so set_config(..., is_local = true)
  // scopes app.user_id to this statement and never leaks to the next pool borrower.
  return transaction(async (client) => (await client.query<T>(text, values)).rows);
}

export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values: unknown[] = []
): Promise<T | null> {
  const rows = await query<T>(text, values);
  return rows[0] ?? null;
}

export async function transaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query('begin');
    const user = currentDbUser();
    if (user) await client.query(`select set_config('app.user_id', $1, true)`, [user]);
    const value = await work(client);
    await client.query('commit');
    return value;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
