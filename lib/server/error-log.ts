/**
 * Server errors kept for the owner's console: what failed, where and why. Best-effort and
 * fire-and-forget: recording an error never throws, never waits, and a missing table (before
 * migration 112) is simply skipped.
 */
import { query } from './db';

export interface ErrorRecord { source: 'api' | 'engine' | 'cron' | 'webhook'; route?: string | null; status?: number | null; message: string; detail?: string | null; tenantId?: string | null; matterId?: string | null }

let disabled = false;

export function recordError(e: ErrorRecord): void {
  if (disabled) return;
  void query(
    `insert into app_error (source, route, status, message, detail, tenant_id, matter_id) values ($1, $2, $3, $4, $5, $6, $7)`,
    [e.source, e.route ?? null, e.status ?? null, e.message.slice(0, 1000), e.detail?.slice(0, 2000) ?? null, e.tenantId ?? null, e.matterId ?? null]
  ).catch((err: Error) => { if (/app_error/.test(err.message) && /does not exist/.test(err.message)) disabled = true; });
}

/** The API route an error came from, read off its stack ("matters/[matterId]/engine"). */
export function routeFromStack(stack: string | undefined): string | null {
  const m = /app\/api\/v1\/(.+?)\/route\.[jt]s/.exec(stack ?? '');
  return m ? m[1] : null;
}

/** The first frames of a stack that are ours, for the detail line. */
export function stackTop(stack: string | undefined): string | null {
  if (!stack) return null;
  return stack.split('\n').slice(0, 6).join('\n');
}
