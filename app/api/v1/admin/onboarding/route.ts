import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireRole } from '@/lib/server/session';
import { getOnboardingStatus, patchOnboardingState, setFirmName, provisionFirm, markOnboarded } from '@/lib/server/onboarding-setup';
import { listInvites } from '@/lib/server/invites';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The firm's onboarding checklist state + any pending team invites. */
export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    const [status, invites] = await Promise.all([getOnboardingStatus(user.tenantId), listInvites(user.tenantId)]);
    return ok({ ...status, invites });
  } catch (error) {
    return fail(error);
  }
}

/** Drive the checklist: name the firm, provision the workspace, ack/skip a step, or finish. */
export async function POST(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    const body = z
      .object({
        action: z.enum(['firm', 'provision', 'state', 'complete']),
        firmName: z.string().max(120).optional(),
        patch: z.record(z.boolean()).optional(),
      })
      .parse(await req.json());

    if (body.action === 'firm') {
      await setFirmName(user.tenantId, body.firmName ?? '');
    } else if (body.action === 'provision') {
      const result = await provisionFirm(user);
      const status = await getOnboardingStatus(user.tenantId);
      return ok({ result, status });
    } else if (body.action === 'state') {
      await patchOnboardingState(user.tenantId, body.patch ?? {});
    } else if (body.action === 'complete') {
      await markOnboarded(user.tenantId);
    }
    return ok({ status: await getOnboardingStatus(user.tenantId) });
  } catch (error) {
    return fail(error);
  }
}
