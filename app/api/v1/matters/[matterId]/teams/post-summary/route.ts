import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertMatterAccess } from '@/lib/server/guard';
import { getMatterSummary } from '@/lib/server/matter';
import { postTeamsSummary } from '@/lib/server/graph';
import { writeAudit } from '@/lib/server/audit';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: Promise<{ matterId: string }> }) {
  try {
    assertFeature('auth');
    assertFeature('graph');
    const user = await requireUser();
    const { matterId } = z.object({ matterId: z.string().uuid() }).parse(await params);
    const body = z.object({ teamId: z.string(), channelId: z.string() }).parse(await req.json());
    await assertMatterAccess(user, matterId);

    const summary = await getMatterSummary(matterId, user.tenantId);
    if (!summary) return fail(new Error('Matter not found'));

    const outstanding = (summary.summary.outstanding_items as string[] | undefined) ?? [];
    const content = [
      `<h3>Matter ${summary.matter.matter_ref}</h3>`,
      `<p><strong>Property:</strong> ${summary.matter.property_address}</p>`,
      '<p><strong>Outstanding:</strong></p>',
      `<ul>${outstanding.map((o) => `<li>${o}</li>`).join('')}</ul>`,
    ].join('');

    const response = await postTeamsSummary(user.userId, body.teamId, body.channelId, content);
    await writeAudit({
      tenantId: user.tenantId,
      matterId,
      actorUserId: user.userId,
      actionType: 'TEAMS_SUMMARY_POSTED',
      actionStatus: 'SUCCESS',
      payload: { teamId: body.teamId, channelId: body.channelId },
    });
    return ok({ id: response.id });
  } catch (error) {
    return fail(error);
  }
}
