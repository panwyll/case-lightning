import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireRole, requireUser } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { query, queryOne } from '@/lib/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The firm's figures from before CONVEYi (migration 114, docs/analytics.md): the "before" in
 * any "faster than before". Append-only — each save is a new row, the latest is current — so
 * a figure can be corrected without losing what was said first.
 */
type Row = { weeks_purchase: string | null; weeks_sale: string | null; cases_per_conveyancer: string | null; hours_per_case: string | null; recorded_at: Date; recorded_by_name: string | null };
const out = (r: Row | null) => r && {
  weeksPurchase: r.weeks_purchase == null ? null : Number(r.weeks_purchase),
  weeksSale: r.weeks_sale == null ? null : Number(r.weeks_sale),
  casesPerConveyancer: r.cases_per_conveyancer == null ? null : Number(r.cases_per_conveyancer),
  hoursPerCase: r.hours_per_case == null ? null : Number(r.hours_per_case),
  recordedAt: r.recorded_at.toISOString(),
  recordedBy: r.recorded_by_name,
};
const latest = (tenantId: string) =>
  queryOne<Row>(
    `select b.weeks_purchase, b.weeks_sale, b.cases_per_conveyancer, b.hours_per_case, b.recorded_at, coalesce(u.display_name, u.email) as recorded_by_name
       from firm_baseline b left join app_user u on u.id = b.recorded_by
      where b.tenant_id = $1 order by b.recorded_at desc limit 1`,
    [tenantId]
  );

export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireUser();
    return ok({ baseline: out(await latest(user.tenantId).catch(() => null)) });
  } catch (error) {
    return fail(error);
  }
}

const num = (max: number) => z.number().positive().max(max).nullable();
export async function PUT(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    const b = z.object({ weeksPurchase: num(104), weeksSale: num(104), casesPerConveyancer: num(1000), hoursPerCase: num(500) }).parse(await req.json());
    if (Object.values(b).every((v) => v == null)) throw Object.assign(new Error('Enter at least one figure.'), { status: 400 });
    await query(
      `insert into firm_baseline (tenant_id, weeks_purchase, weeks_sale, cases_per_conveyancer, hours_per_case, recorded_by) values ($1,$2,$3,$4,$5,$6)`,
      [user.tenantId, b.weeksPurchase, b.weeksSale, b.casesPerConveyancer, b.hoursPerCase, user.userId]
    ).catch((e: Error) => {
      if (/firm_baseline/.test(e.message)) throw Object.assign(new Error('Saving these needs migration 114.'), { status: 503 });
      throw e;
    });
    return ok({ baseline: out(await latest(user.tenantId)) });
  } catch (error) {
    return fail(error);
  }
}
