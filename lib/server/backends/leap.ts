/**
 * LEAP (leap.build) as the backend — the CaseBackend view over lib/server/integrations/leap.
 */
import type { CaseBackend } from '../engine/backend';
import { PgDocumentBytesLoader } from '../engine/pg-documents';
import { LeapDocumentBytesLoader, LeapDocumentRepository, leapConnection, leapOnEvents, leapWritebackEnabled } from '../integrations/leap/adapters';
import { TRIGGERS_BY_BACKEND } from '../engine/triggers';
import { queryOne, runAsSystem } from '../db';

export function leapBackend(): CaseBackend {
  return {
    kind: 'leap',
    label: 'LEAP (leap.build)',
    documents: new LeapDocumentRepository(),
    bytes: new LeapDocumentBytesLoader(new PgDocumentBytesLoader()),
    conclusions: leapWritebackEnabled() ? { name: 'leap-tasks-and-file-notes', onEvents: leapOnEvents } : null,
    matters: {
      async handlerOf(tenantId, matterId) {
        const m = await runAsSystem(() => queryOne<{ assigned_to: string | null; created_by: string }>(`select assigned_to, created_by from matter where id = $1 and tenant_id = $2`, [matterId, tenantId]));
        return m?.assigned_to ?? m?.created_by ?? null;
      },
      async externalRef(tenantId, matterId) {
        const m = await runAsSystem(() => queryOne<{ leap_matter_id: string | null; firm_ref: string | null }>(`select leap_matter_id, firm_ref from matter where id = $1 and tenant_id = $2`, [matterId, tenantId]));
        return m?.leap_matter_id ?? m?.firm_ref ?? null;
      },
    },
    triggers: TRIGGERS_BY_BACKEND('leap'),
    status: async () => {
      // One connection per firm; report the first connected firm's state (single-tenant deployments) or a count.
      const rows = await runAsSystem(() => queryOne<{ n: string; connected: string }>(`select count(*)::text as n, count(*) filter (where status = 'CONNECTED')::text as connected from leap_connection`)).catch(() => null);
      void leapConnection;
      const n = Number(rows?.n ?? 0);
      const c = Number(rows?.connected ?? 0);
      return { ok: c > 0, detail: n ? `${c} of ${n} firm connection(s) live; documents in LEAP; conclusions written back as tasks + file notes` : 'configured, no firm connected yet' };
    },
  };
}
