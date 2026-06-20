import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { query, queryOne } from '@/lib/server/db';
import { isPremiumTenant } from '@/lib/server/plan';
import { getActiveJob, getLatestJob, sinceForLookback, type OnboardingJob } from '@/lib/server/onboarding';
import { writeAudit } from '@/lib/server/audit';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FREE_LOOKBACK_MONTHS = 3;

/** Start a backlog scan. Non-premium tenants are clamped to the free lookback. */
export async function POST(req: NextRequest) {
  try {
    assertFeature('auth');
    assertFeature('graph');
    assertFeature('ai');
    const user = await requireUser();
    // lookbackMonths: omitted → free default; null → unlimited (premium only).
    const body = z
      .object({ lookbackMonths: z.number().int().positive().nullable().optional() })
      .parse(await req.json().catch(() => ({})));

    if (await getActiveJob(user.userId)) {
      return fail(new Error('An onboarding scan is already in progress.'));
    }

    const premium = await isPremiumTenant(user.tenantId);
    let months: number | null = body.lookbackMonths === undefined ? FREE_LOOKBACK_MONTHS : body.lookbackMonths;
    // Only premium tenants may look back further than the free window.
    if (!premium && (months === null || months > FREE_LOOKBACK_MONTHS)) months = FREE_LOOKBACK_MONTHS;

    const since = sinceForLookback(months);
    const job = await queryOne<OnboardingJob>(
      `insert into onboarding_job (tenant_id, user_id, status, lookback_months, since, started_at)
       values ($1,$2,'SCANNING',$3,$4, now())
       returning id, tenant_id, user_id, status, lookback_months, since, scan_cursor, messages_scanned, threads_found, cases_proposed, cases_onboarded, error`,
      [user.tenantId, user.userId, months, since]
    );

    await writeAudit({
      tenantId: user.tenantId,
      actorUserId: user.userId,
      actionType: 'ONBOARDING_STARTED',
      actionStatus: 'SUCCESS',
      payload: { lookbackMonths: months, premium },
    });

    return ok({ job });
  } catch (error) {
    return fail(error);
  }
}

/** Current job status + counters, plus proposed cases once a review is pending. */
export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const job = await getLatestJob(user.userId);
    if (!job) return ok({ job: null, cases: [] });

    let cases: unknown[] = [];
    if (['AWAITING_REVIEW', 'PROVISIONING', 'COMPLETED'].includes(job.status)) {
      cases = await query(
        `select id, cluster_key, proposed_matter_ref, property_address, buyer_names, seller_names,
                counterparty_solicitor, counterparty_agent, confidence, rationale, thread_count, message_count, status, matter_id
         from onboarding_case
         where job_id = $1 and status in ('PROPOSED','APPROVED','ONBOARDED','FAILED')
         order by confidence desc nulls last, message_count desc`,
        [job.id]
      );
    }
    return ok({ job, cases });
  } catch (error) {
    return fail(error);
  }
}

/** Cancel the active job. */
export async function DELETE() {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const job = await getActiveJob(user.userId);
    if (job) {
      await query(
        `update onboarding_job set status = 'CANCELLED', completed_at = now(), updated_at = now() where id = $1`,
        [job.id]
      );
      await writeAudit({
        tenantId: user.tenantId,
        actorUserId: user.userId,
        actionType: 'ONBOARDING_CANCELLED',
        actionStatus: 'SUCCESS',
        payload: { jobId: job.id },
      });
    }
    return ok({ cancelled: Boolean(job) });
  } catch (error) {
    return fail(error);
  }
}
