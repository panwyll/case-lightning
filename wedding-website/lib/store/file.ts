import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Rsvp, Store, Visit, VisitSummary } from './types';

/**
 * Zero-setup store for local development: one JSON file under .data/.
 *
 * Deliberately not for production — serverless filesystems are ephemeral and
 * per-instance, so RSVPs written here on Vercel would silently vanish. Set
 * DATABASE_URL and the Postgres driver takes over.
 */

type Shape = { rsvps: Record<string, Rsvp>; visits: Visit[] };

const EMPTY: Shape = { rsvps: {}, visits: [] };
const MAX_VISITS = 5000;

export function createFileStore(dir = path.join(process.cwd(), '.data')): Store {
  const file = path.join(dir, 'store.json');
  let queue: Promise<unknown> = Promise.resolve();

  /** Serialises read-modify-write cycles so concurrent requests can't clobber. */
  function withData<T>(fn: (data: Shape) => T | Promise<T>, save: boolean): Promise<T> {
    const next = queue.then(async () => {
      let data: Shape = EMPTY;
      try {
        data = { ...EMPTY, ...(JSON.parse(await readFile(file, 'utf8')) as Shape) };
      } catch {
        // No file yet, or unreadable — start from empty.
      }
      const result = await fn(data);
      if (save) {
        await mkdir(dir, { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
        await rename(tmp, file); // atomic swap, so a crash can't truncate the store
      }
      return result;
    });
    queue = next.catch(() => undefined);
    return next;
  }

  return {
    name: 'file (.data/store.json)',

    async ready() {
      await mkdir(dir, { recursive: true });
    },

    async saveRsvp(rsvp) {
      await withData((data) => {
        const existing = data.rsvps[rsvp.slug];
        data.rsvps[rsvp.slug] = {
          ...rsvp,
          submittedAt: existing?.submittedAt ?? rsvp.submittedAt,
        };
      }, true);
    },

    async getRsvp(slug) {
      return withData((data) => data.rsvps[slug] ?? null, false);
    },

    async listRsvps() {
      return withData((data) => Object.values(data.rsvps), false);
    },

    async recordVisit(visit) {
      await withData((data) => {
        data.visits.push(visit);
        if (data.visits.length > MAX_VISITS) {
          data.visits.splice(0, data.visits.length - MAX_VISITS);
        }
      }, true);
    },

    async visitSummary() {
      return withData((data) => {
        const out: Record<string, VisitSummary> = {};
        for (const visit of data.visits) {
          if (!visit.slug) continue;
          const row = out[visit.slug];
          if (!row) {
            out[visit.slug] = { count: 1, first: visit.at, last: visit.at };
          } else {
            row.count += 1;
            if (visit.at < row.first) row.first = visit.at;
            if (visit.at > row.last) row.last = visit.at;
          }
        }
        return out;
      }, false);
    },

    async listVisits(slug, limit = 50) {
      return withData(
        (data) =>
          data.visits
            .filter((v) => v.slug === slug)
            .sort((a, b) => b.at.localeCompare(a.at))
            .slice(0, limit),
        false,
      );
    },
  };
}
