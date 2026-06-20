import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { query } from '@/lib/server/db';
import { getActiveJob } from '@/lib/server/onboarding';
import { writeAudit } from '@/lib/server/audit';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  selections: z.array(
    z.object({
      caseId: z.string().uuid(),
      approved: z.boolean(),
      edits: z
        .object({
          matterRef: z.string().optional(),
          propertyAddress: z.string().optional(),
          buyerNames: z.array(z.string()).optional(),
          sellerNames: z.array(z.string()).optional(),
        })
        .optional(),
    })
  ),
});

/**
 * Apply the user's review: mark cases APPROVED/REJECTED (any case left
 * untouched defaults to REJECTED) and move the job into PROVISIONING. The
 * taskpane then resumes polling /process until the job COMPLETES.
 */
export async function POST(req: NextRequest) {
  try {
    assertFeature('auth');
    assertFeature('graph');
    const user = await requireUser();
    const { selections } = Body.parse(await req.json());

    const job = await getActiveJob(user.userId);
    if (!job) return fail(new Error('No onboarding job awaiting review.'));
    if (job.status !== 'AWAITING_REVIEW') return fail(new Error(`Job is ${job.status}, not awaiting review.`));

    let approved = 0;
    for (const s of selections) {
      await query(
        `update onboarding_case set status = $1, edits = $2::jsonb, updated_at = now()
         where id = $3 and job_id = $4 and tenant_id = $5 and status = 'PROPOSED'`,
        [s.approved ? 'APPROVED' : 'REJECTED', s.edits ? JSON.stringify(s.edits) : null, s.caseId, job.id, user.tenantId]
      );
      if (s.approved) approved++;
    }
    // Anything the user didn't explicitly approve is rejected.
    await query(`update onboarding_case set status = 'REJECTED', updated_at = now() where job_id = $1 and status = 'PROPOSED'`, [job.id]);
    await query(`update onboarding_job set status = 'PROVISIONING', updated_at = now() where id = $1`, [job.id]);

    await writeAudit({
      tenantId: user.tenantId,
      actorUserId: user.userId,
      actionType: 'ONBOARDING_CONFIRMED',
      actionStatus: 'SUCCESS',
      payload: { jobId: job.id, approved },
    });

    return ok({ status: 'PROVISIONING', approved });
  } catch (error) {
    return fail(error);
  }
}
