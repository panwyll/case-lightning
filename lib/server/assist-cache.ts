/**
 * Read/write the precomputed taskpane assist result (see migration 015).
 *
 * READY   — full result (fast + slow) is cached; the taskpane renders it instantly.
 * PARTIAL — only the fast half is cached; the slow half is being computed.
 * ERROR   — the slow computation failed; the taskpane can fall back to a live run.
 */
import { query, queryOne } from './db';
import type { AssistResult } from './assist';

export type AssistStatus = 'PARTIAL' | 'READY' | 'ERROR';

export interface CachedAssist {
  status: AssistStatus;
  result: AssistResult;
  error: string | null;
}

export async function readAssistCache(tenantId: string, messageId: string): Promise<CachedAssist | null> {
  const row = await queryOne<CachedAssist>(
    `select status, result, error from assist_cache where tenant_id = $1 and graph_message_id = $2`,
    [tenantId, messageId]
  );
  return row ?? null;
}

export async function writeAssistCache(
  tenantId: string,
  messageId: string,
  result: AssistResult,
  status: AssistStatus
): Promise<void> {
  await query(
    `insert into assist_cache (tenant_id, graph_message_id, status, result, error, updated_at)
     values ($1, $2, $3, $4::jsonb, null, now())
     on conflict (tenant_id, graph_message_id) do update set
       status = excluded.status,
       result = excluded.result,
       error = null,
       updated_at = now()`,
    [tenantId, messageId, status, JSON.stringify(result)]
  );
}

export async function markAssistError(tenantId: string, messageId: string, message: string): Promise<void> {
  await query(
    `update assist_cache set status = 'ERROR', error = $3, updated_at = now()
     where tenant_id = $1 and graph_message_id = $2`,
    [tenantId, messageId, message]
  );
}
