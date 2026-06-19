/**
 * Raw Postgres access against Supabase (via DATABASE_URL / connection pooler).
 *
 * We use `pg` directly rather than supabase-js because the RAG retrieval path needs
 * the pgvector `<=>` operator, which supabase-js cannot express without an RPC.
 * The pool is created lazily so importing this module never crashes a build when
 * DATABASE_URL is absent (the marketing site must keep deploying).
 */
import pg from 'pg';
import { config } from './config';

const { Pool } = pg;
type QueryResultRow = pg.QueryResultRow;

let _pool: pg.Pool | null = null;

export function pool(): pg.Pool {
  if (!_pool) {
    if (!config.databaseUrl) {
      throw new Error('DATABASE_URL is not set; database features are unavailable.');
    }
    _pool = new Pool({
      connectionString: config.databaseUrl,
      // Supabase requires TLS; allow self-signed on the pooler.
      ssl: config.databaseUrl.includes('localhost') ? undefined : { rejectUnauthorized: false },
      max: 5,
    });
  }
  return _pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values: unknown[] = []
): Promise<T[]> {
  const result = await pool().query<T>(text, values);
  return result.rows;
}

export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values: unknown[] = []
): Promise<T | null> {
  const result = await pool().query<T>(text, values);
  return result.rows[0] ?? null;
}

export async function transaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query('begin');
    const value = await work(client);
    await client.query('commit');
    return value;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
