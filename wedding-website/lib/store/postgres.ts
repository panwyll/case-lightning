import { Pool } from 'pg';
import type { Rsvp, Store, Visit, VisitSummary } from './types';

/**
 * Production driver. Any Postgres works — Vercel Postgres, Neon, Supabase,
 * a box under a desk. Run `npm run migrate` once to create the tables.
 */

let pool: Pool | null = null;

function db(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is not set');
    pool = new Pool({
      connectionString,
      max: 3,
      ssl: connectionString.includes('sslmode=disable') ? undefined : { rejectUnauthorized: false },
    });
  }
  return pool;
}

export const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS rsvps (
  slug          TEXT PRIMARY KEY,
  members       JSONB NOT NULL,
  extras        JSONB NOT NULL DEFAULT '{}'::jsonb,
  message       TEXT,
  submitted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS visits (
  id        BIGSERIAL PRIMARY KEY,
  slug      TEXT,
  path      TEXT NOT NULL,
  referrer  TEXT,
  at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS visits_slug_at_idx ON visits (slug, at DESC);
`;

function rowToRsvp(row: {
  slug: string;
  members: Rsvp['members'];
  extras: Rsvp['extras'] | null;
  message: string | null;
  submitted_at: Date;
  updated_at: Date;
}): Rsvp {
  return {
    slug: row.slug,
    members: row.members,
    extras: row.extras ?? {},
    message: row.message ?? undefined,
    submittedAt: row.submitted_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function createPostgresStore(): Store {
  return {
    name: 'postgres',

    async ready() {
      await db().query(MIGRATION_SQL);
    },

    async saveRsvp(rsvp) {
      // submitted_at is kept from the first submission; updated_at always moves.
      await db().query(
        `INSERT INTO rsvps (slug, members, extras, message, submitted_at, updated_at)
         VALUES ($1, $2::jsonb, $3::jsonb, $4, now(), now())
         ON CONFLICT (slug) DO UPDATE
           SET members = EXCLUDED.members,
               extras = EXCLUDED.extras,
               message = EXCLUDED.message,
               updated_at = now()`,
        [rsvp.slug, JSON.stringify(rsvp.members), JSON.stringify(rsvp.extras), rsvp.message ?? null],
      );
    },

    async getRsvp(slug) {
      const { rows } = await db().query('SELECT * FROM rsvps WHERE slug = $1', [slug]);
      return rows[0] ? rowToRsvp(rows[0]) : null;
    },

    async listRsvps() {
      const { rows } = await db().query('SELECT * FROM rsvps ORDER BY updated_at DESC');
      return rows.map(rowToRsvp);
    },

    async recordVisit(visit) {
      await db().query(
        'INSERT INTO visits (slug, path, referrer, at) VALUES ($1, $2, $3, $4)',
        [visit.slug, visit.path, visit.referrer ?? null, visit.at],
      );
    },

    async visitSummary() {
      const { rows } = await db().query(
        `SELECT slug, COUNT(*)::int AS count, MIN(at) AS first, MAX(at) AS last
         FROM visits WHERE slug IS NOT NULL GROUP BY slug`,
      );
      const out: Record<string, VisitSummary> = {};
      for (const row of rows as { slug: string; count: number; first: Date; last: Date }[]) {
        out[row.slug] = {
          count: row.count,
          first: row.first.toISOString(),
          last: row.last.toISOString(),
        };
      }
      return out;
    },

    async listVisits(slug, limit = 50) {
      const { rows } = await db().query(
        'SELECT slug, path, referrer, at FROM visits WHERE slug = $1 ORDER BY at DESC LIMIT $2',
        [slug, limit],
      );
      return (rows as { slug: string; path: string; referrer: string | null; at: Date }[]).map(
        (r): Visit => ({
          slug: r.slug,
          path: r.path,
          referrer: r.referrer ?? undefined,
          at: r.at.toISOString(),
        }),
      );
    },
  };
}
