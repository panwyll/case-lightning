/**
 * Premium-tier gate. The premium automation (auto-rules, auto-triage actions) is
 * reserved for the Team plan. When Stripe isn't configured (pilot / self-host),
 * we don't block — there's no billing to check against.
 */
import { config } from './config';
import { queryOne } from './db';

export async function isPremiumTenant(tenantId: string): Promise<boolean> {
  if (!config.stripeSecretKey) return true; // billing not in play → don't gate
  const account = await queryOne<{ plan: string | null; status: string }>(
    `select plan, status from billing_account where tenant_id = $1 order by updated_at desc limit 1`,
    [tenantId]
  );
  return account?.plan === 'team' && account.status === 'active';
}
