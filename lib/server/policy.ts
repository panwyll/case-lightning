/** Firm-level policy switches (migration 098). Missing rows are the default. */
import { query, queryOne } from './db';

export type SigningProvider = 'none' | 'infotrack' | 'intouch' | 'leap' | 'mock';
export const POLICY_DEFAULTS: { protectOutgoingFiles: boolean; archiveHandledEmail: boolean; signingProvider: SigningProvider; clientReminderHours: number } = {
  /** Outgoing files go as a password-protected zip, with the password sent separately (WhatsApp where the client has opted in, otherwise its own message). */
  protectOutgoingFiles: false,
  /** Email filed to a case or set aside here is archived in the mailbox, so the Outlook inbox matches the Email tab. */
  archiveHandledEmail: true,
  /** Who the firm signs deeds electronically with ('none': wet ink only). A lender that does not take an e-signed mortgage deed is wet ink regardless. */
  signingProvider: 'none',
  /** A client update mentions what the client still owes us only if nobody has asked them about it (an update, a chase, the request itself) in this many hours. */
  clientReminderHours: 24,
};
export type PolicyKey = keyof typeof POLICY_DEFAULTS;

export async function getPolicy<K extends PolicyKey>(tenantId: string, key: K): Promise<(typeof POLICY_DEFAULTS)[K]> {
  const row = await queryOne<{ value: unknown }>(`select value from tenant_policy where tenant_id = $1 and key = $2`, [tenantId, key]).catch(() => null);
  return (row?.value as (typeof POLICY_DEFAULTS)[K] | undefined) ?? POLICY_DEFAULTS[key];
}

export async function allPolicies(tenantId: string): Promise<typeof POLICY_DEFAULTS> {
  const rows = await query<{ key: string; value: unknown }>(`select key, value from tenant_policy where tenant_id = $1`, [tenantId]).catch(() => []);
  const out = { ...POLICY_DEFAULTS } as Record<string, unknown>;
  for (const r of rows) if (r.key in POLICY_DEFAULTS) out[r.key] = r.value;
  return out as typeof POLICY_DEFAULTS;
}

export async function setPolicy<K extends PolicyKey>(tenantId: string, key: K, value: (typeof POLICY_DEFAULTS)[K], userId: string | null): Promise<void> {
  await query(`insert into tenant_policy (tenant_id, key, value, updated_by) values ($1, $2, $3::jsonb, $4) on conflict (tenant_id, key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`, [tenantId, key, JSON.stringify(value), userId]);
}
