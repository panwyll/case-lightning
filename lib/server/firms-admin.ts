/**
 * Every firm's billing standing, and comping one (free, full service) with or without an end
 * date. Used by the owner's /internal dashboard (its key) and the in-app Firms page.
 */
import { query, queryOne } from './db';
import { getTenantBilling } from './plan';
import { accountForUser } from './referrals';

export async function listFirms() {
  const firms = await query<{ id: string; name: string; created_at: string; users: number; cases: number; comp_plan: string | null; comp_until: string | null; contact: string | null }>(
    `select t.id, t.name, t.created_at::text,
            (select email from app_user u where u.tenant_id = t.id order by (u.role = 'ADMIN') desc, u.created_at limit 1) as contact,
            (select count(*) from app_user u where u.tenant_id = t.id)::int as users,
            (select count(*) from matter m where m.tenant_id = t.id and coalesce(m.sandbox, false) = false)::int as cases,
            b.comp_plan, b.comp_until::text
       from tenant t
       left join lateral (select comp_plan, comp_until from billing_account where tenant_id = t.id order by updated_at desc limit 1) b on true
      order by t.created_at desc limit 500`
  );
  return Promise.all(firms.map(async (f) => {
    const b = await getTenantBilling(f.id).catch(() => null);
    return { ...f, status: b?.status ?? 'unknown', entitled: b?.entitled ?? false, trialEndsAt: b?.trialEndsAt ?? null, graceEndsAt: b?.graceEndsAt ?? null };
  }));
}

export async function setComp(tenantId: string, comp: boolean, until: string | null): Promise<void> {
  // The firm needs a billing record to carry the comp: one is made from its first admin, as sign-in would.
  let acct = await queryOne<{ id: string }>(`select id from billing_account where tenant_id = $1 order by updated_at desc limit 1`, [tenantId]);
  if (!acct) {
    const admin = await queryOne<{ email: string }>(`select email from app_user where tenant_id = $1 order by (role = 'ADMIN') desc, created_at limit 1`, [tenantId]);
    if (!admin) throw Object.assign(new Error('That firm has nobody signed in yet.'), { status: 409 });
    await accountForUser(tenantId, admin.email);
    acct = await queryOne<{ id: string }>(`select id from billing_account where tenant_id = $1 order by updated_at desc limit 1`, [tenantId]);
  }
  await query(`update billing_account set comp_plan = $2, comp_until = $3::timestamptz, updated_at = now() where id = $1`, [acct!.id, comp ? 'comp' : null, comp && until ? `${until}T23:59:59Z` : null]);
  // Comped after a suspension: they pick up where they left off.
  if (comp) {
    const { releaseHeldMail } = await import('./billing-suspension');
    await releaseHeldMail(tenantId).catch(() => {});
  }
}
