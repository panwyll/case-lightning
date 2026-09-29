import { getSessionUser } from '@/lib/server/session';
import { AppShell } from '@/app/shared/AppNav';
import { BillingBanner } from '@/app/shared/BillingBanner';
import { getTenantBilling } from '@/lib/server/plan';
import { queryOne } from '@/lib/server/db';

/**
 * Every page behind the sign-in wall sits in the same shell. The session is read here,
 * on the server, so the nav is drawn on the first paint — no fetch, no flicker — and
 * page changes swap only the content.
 */
export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  const me = user ? { role: user.role, displayName: user.displayName ?? null, email: user.email, actor: user.actor ? { displayName: user.actor.displayName, email: user.actor.email } : null } : null;
  // A failed payment or a suspension is said on every page, with the way to pay.
  const billing = user ? await getTenantBilling(user.tenantId).catch(() => null) : null;
  const banner = billing?.grace ? 'grace' : billing?.suspended && !billing.pilot ? 'suspended' : null;
  const subscribed = banner ? !!(await queryOne<{ id: string }>(`select id from billing_account where tenant_id = $1 and stripe_subscription_id is not null and status <> 'canceled' limit 1`, [user!.tenantId]).catch(() => null)) : false;
  return <AppShell me={me}>{banner && <BillingBanner state={banner} until={billing?.graceEndsAt ?? null} subscribed={subscribed} />}{children}</AppShell>;
}
