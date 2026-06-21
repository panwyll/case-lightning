import { NextRequest } from 'next/server';
import { assertFeature } from '@/lib/server/config';
import { query } from '@/lib/server/db';
import { advanceJob, type OnboardingJob } from '@/lib/server/onboarding';
import { ok, fail } from '@/lib/server/http';
import type { SessionUser } from '@/lib/server/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Nudge onboarding jobs that stalled mid-scan/propose/provision — e.g. the user
 * closed the taskpane before the job finished. Advances each by one slice so a
 * long premium import still makes progress unattended. Intended for a Vercel
 * Cron; protected by CRON_SECRET when set (sent as a Bearer token), mirroring
 * the subscriptions-renew cron.
 */
export async function GET(req: NextRequest) {
  try {
    assertFeature('auth');
    assertFeature('graph');
    const secret = process.env.CRON_SECRET;
    if (secret && req.headers.get('authorization') !== `Bearer ${secret}`) {
      return fail(new Error('Unauthorized'));
    }

    const stuck = await query<
      OnboardingJob & { email: string; display_name: string | null; role: SessionUser['role'] }
    >(
      `select j.id, j.tenant_id, j.user_id, j.status, j.lookback_months, j.since, j.scan_cursor,
              j.messages_scanned, j.threads_found, j.cases_proposed, j.cases_onboarded, j.error,
              u.email, u.display_name, u.role
       from onboarding_job j
       join app_user u on u.id = j.user_id
       where j.status in ('SCANNING','CLUSTERING','PROPOSING','PROVISIONING')
         and j.updated_at < now() - interval '5 minutes'
       limit 20`
    );

    // Each advance can now drain many Graph pages (~12s), so stop before the
    // function timeout rather than starting a slice we can't finish. Remaining
    // jobs are picked up on the next cron run (they stay 'stuck' until done).
    const deadline = Date.now() + 45_000;
    let advanced = 0;
    for (const job of stuck) {
      if (Date.now() > deadline) break;
      const user: SessionUser = {
        userId: job.user_id,
        tenantId: job.tenant_id,
        role: job.role,
        email: job.email,
        displayName: job.display_name,
      };
      try {
        await advanceJob(user, job);
        advanced++;
      } catch {
        /* advanceJob already records failure on the job; keep going */
      }
    }

    return ok({ checked: stuck.length, advanced });
  } catch (error) {
    return fail(error);
  }
}
