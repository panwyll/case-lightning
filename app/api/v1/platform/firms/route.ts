import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { query, queryOne } from '@/lib/server/db';
import { ok, fail } from '@/lib/server/http';
import { assertPlatformAdmin } from '@/lib/server/platform-admin';
import { getTenantBilling } from '@/lib/server/plan';
import { accountForUser } from '@/lib/server/referrals';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Every firm, with where it stands on billing: for the people who run CONVEYi. */
export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireUser();
    assertPlatformAdmin(user);
    const firms = await query<{ id: string; name: string; created_at: string; users: number; cases: number; comp_plan: string | null; comp_until: string | null }>(
      `select t.id, t.name, t.created_at::text,
              (select count(*) from app_user u where u.tenant_id = t.id)::int as users,
              (select count(*) from matter m where m.tenant_id = t.id and coalesce(m.sandbox, false) = false)::int as cases,
              b.comp_plan, b.comp_until::text
         from tenant t
         left join lateral (select comp_plan, comp_until from billing_account where tenant_id = t.id order by updated_at desc limit 1) b on true
        order by t.created_at desc limit 500`
    );
    const out = await Promise.all(firms.map(async (f) => {
      const b = await getTenantBilling(f.id).catch(() => null);
      return { ...f, status: b?.status ?? 'unknown', entitled: b?.entitled ?? false, trialEndsAt: b?.trialEndsAt ?? null, graceEndsAt: b?.graceEndsAt ?? null };
    }));
    return ok({ firms: out });
  } catch (error) {
    return fail(error);
  }
}

/** Comp a firm (free, full service), optionally until a date; or end a comp. */
export async function PATCH(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    assertPlatformAdmin(user);
    const body = z.object({ tenantId: z.string().uuid(), comp: z.boolean(), until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish() }).parse(await req.json());
    // The firm needs a billing record to carry the comp: one is made from its first admin, as sign-in would.
    let acct = await queryOne<{ id: string }>(`select id from billing_account where tenant_id = $1 order by updated_at desc limit 1`, [body.tenantId]);
    if (!acct) {
      const admin = await queryOne<{ email: string }>(`select email from app_user where tenant_id = $1 order by (role = 'ADMIN') desc, created_at limit 1`, [body.tenantId]);
      if (!admin) throw Object.assign(new Error('That firm has nobody signed in yet.'), { status: 409 });
      await accountForUser(body.tenantId, admin.email);
      acct = await queryOne<{ id: string }>(`select id from billing_account where tenant_id = $1 order by updated_at desc limit 1`, [body.tenantId]);
    }
    await query(`update billing_account set comp_plan = $2, comp_until = $3::timestamptz, updated_at = now() where id = $1`, [acct!.id, body.comp ? 'comp' : null, body.comp && body.until ? `${body.until}T23:59:59Z` : null]);
    // Comped after a suspension: they pick up where they left off.
    if (body.comp) {
      const { releaseHeldMail } = await import('@/lib/server/billing-suspension');
      await releaseHeldMail(body.tenantId).catch(() => {});
    }
    return ok({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
