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
type Row = { weeks_purchase: string | null; weeks_sale: string | null; cases_per_conveyancer: string | null; hours_per_case: string | null; fee_per_completion_pennies: string | null; pay_per_completion_pennies: string | null; contracted_hours: string | null; typing_wpm: number | null; workday_start: string | null; workday_end: string | null; recorded_at: Date; recorded_by_name: string | null };
const out = (r: Row | null) => r && {
  weeksPurchase: r.weeks_purchase == null ? null : Number(r.weeks_purchase),
  weeksSale: r.weeks_sale == null ? null : Number(r.weeks_sale),
  casesPerConveyancer: r.cases_per_conveyancer == null ? null : Number(r.cases_per_conveyancer),
  hoursPerCase: r.hours_per_case == null ? null : Number(r.hours_per_case),
  // The workload baseline's money and week (migration 124, docs/workload-baseline.md §6).
  feePerCompletion: r.fee_per_completion_pennies == null ? null : Number(r.fee_per_completion_pennies) / 100,
  payPerCompletion: r.pay_per_completion_pennies == null ? null : Number(r.pay_per_completion_pennies) / 100,
  contractedHours: r.contracted_hours == null ? null : Number(r.contracted_hours),
  typingWpm: r.typing_wpm,
  workdayStart: r.workday_start,
  workdayEnd: r.workday_end,
  recordedAt: r.recorded_at.toISOString(),
  recordedBy: r.recorded_by_name,
};
const latest = (tenantId: string) =>
  queryOne<Row>(
    `select b.weeks_purchase, b.weeks_sale, b.cases_per_conveyancer, b.hours_per_case, b.fee_per_completion_pennies, b.pay_per_completion_pennies, b.contracted_hours, b.typing_wpm, b.workday_start, b.workday_end, b.recorded_at, coalesce(u.display_name, u.email) as recorded_by_name
       from firm_baseline b left join app_user u on u.id = b.recorded_by
      where b.tenant_id = $1 order by b.recorded_at desc limit 1`,
    [tenantId]
  ).catch((e: Error) => {
    // Before migration 124 the money and week columns are not there: the figures from 114 still show.
    if (!/column .* does not exist/.test(e.message)) throw e;
    return queryOne<Row>(
      `select b.weeks_purchase, b.weeks_sale, b.cases_per_conveyancer, b.hours_per_case, null as fee_per_completion_pennies, null as pay_per_completion_pennies, null as contracted_hours, null as typing_wpm, null as workday_start, null as workday_end, b.recorded_at, coalesce(u.display_name, u.email) as recorded_by_name
         from firm_baseline b left join app_user u on u.id = b.recorded_by where b.tenant_id = $1 order by b.recorded_at desc limit 1`,
      [tenantId]
    );
  });

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
    const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().optional();
    const b = z.object({ weeksPurchase: num(104), weeksSale: num(104), casesPerConveyancer: num(1000), hoursPerCase: num(500), feePerCompletion: num(100_000).optional(), payPerCompletion: num(100_000).optional(), contractedHours: num(80).optional(), typingWpm: num(150).optional(), workdayStart: time, workdayEnd: time }).parse(await req.json());
    if (Object.values(b).every((v) => v == null)) throw Object.assign(new Error('Enter at least one figure.'), { status: 400 });
    if (b.workdayStart && b.workdayEnd && b.workdayStart >= b.workdayEnd) throw Object.assign(new Error('The working day must end after it starts.'), { status: 400 });
    const pennies = (x: number | null | undefined) => (x == null ? null : Math.round(x * 100));
    await query(
      `insert into firm_baseline (tenant_id, weeks_purchase, weeks_sale, cases_per_conveyancer, hours_per_case, fee_per_completion_pennies, pay_per_completion_pennies, contracted_hours, typing_wpm, workday_start, workday_end, recorded_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [user.tenantId, b.weeksPurchase, b.weeksSale, b.casesPerConveyancer, b.hoursPerCase, pennies(b.feePerCompletion), pennies(b.payPerCompletion), b.contractedHours ?? null, b.typingWpm == null ? null : Math.round(b.typingWpm), b.workdayStart ?? null, b.workdayEnd ?? null, user.userId]
    ).catch((e: Error) => {
      if (/fee_per_completion|workday|typing_wpm|contracted_hours/.test(e.message)) throw Object.assign(new Error('Saving these needs migration 124.'), { status: 503 });
      if (/firm_baseline/.test(e.message)) throw Object.assign(new Error('Saving these needs migration 114.'), { status: 503 });
      throw e;
    });
    return ok({ baseline: out(await latest(user.tenantId)) });
  } catch (error) {
    return fail(error);
  }
}
