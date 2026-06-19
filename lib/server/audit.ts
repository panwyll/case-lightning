import { query } from './db';

interface AuditInput {
  tenantId: string;
  matterId?: string | null;
  actorUserId?: string | null;
  actionType: string;
  actionStatus: 'SUCCESS' | 'BLOCKED' | 'FAILED';
  requestId?: string;
  traceId?: string;
  payload?: Record<string, unknown>;
}

export async function writeAudit(input: AuditInput): Promise<void> {
  await query(
    `insert into audit_log
      (tenant_id, matter_id, actor_user_id, action_type, action_status, request_id, trace_id, payload)
     values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
    [
      input.tenantId,
      input.matterId ?? null,
      input.actorUserId ?? null,
      input.actionType,
      input.actionStatus,
      input.requestId ?? null,
      input.traceId ?? null,
      JSON.stringify(input.payload ?? {}),
    ]
  );
}
