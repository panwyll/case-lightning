/**
 * Security control plane: matter isolation, risk-action approval gates, and
 * external-recipient domain checks. Mirrors the original conveyancing-copilot
 * guard but adapted for Next.js Request headers.
 */
import { queryOne } from './db';
import type { SessionUser } from './types';

export async function assertMatterAccess(user: SessionUser, matterId: string): Promise<void> {
  // Ethical wall (migration 068/069): a targeted read of the other side's matter is an
  // explicit 42501 from the database (→ 403), not a quiet "not found". Lists filter instead.
  await queryOne('select engine_wall_check($1)', [matterId]).catch((err: Error & { code?: string }) => {
    if (err.code === '42501') throw err;
    /* function absent before migration 068 — fall through to the plain lookup */
  });
  const row = await queryOne<{ id: string }>(
    'select id from matter where id = $1 and tenant_id = $2',
    [matterId, user.tenantId]
  );
  if (!row) {
    throw new Error('Case not found or inaccessible');
  }
}

export function assertRiskApproval(headers: Headers): void {
  const approvalToken = headers.get('x-user-approval-token');
  if (!approvalToken) {
    throw new Error('Approval token required for risky action');
  }
}

export function assertCrossMatterAllowed(headers: Headers): void {
  if (headers.get('x-cross-matter') !== 'true') {
    throw new Error('Cross-case retrieval blocked');
  }
  assertRiskApproval(headers);
}

export function externalDomainsAllowed(recipients: string[], allowedDomains: string[]): boolean {
  if (!allowedDomains.length) return true;
  return recipients.every((email) => {
    const domain = email.split('@')[1]?.toLowerCase();
    return domain ? allowedDomains.includes(domain) : false;
  });
}
