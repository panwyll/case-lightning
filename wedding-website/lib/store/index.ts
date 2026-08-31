import { createFileStore } from './file';
import { createPostgresStore } from './postgres';
import type { Store } from './types';

/**
 * DATABASE_URL set  -> Postgres.
 * DATABASE_URL unset -> a JSON file under .data/, so `npm run dev` works with
 *                       no setup at all. See lib/store/file.ts for the caveat.
 */

let instance: Store | null = null;

export function store(): Store {
  if (!instance) {
    instance = process.env.DATABASE_URL ? createPostgresStore() : createFileStore();
  }
  return instance;
}

export type { Rsvp, MemberResponse, Store, Visit, VisitSummary } from './types';
