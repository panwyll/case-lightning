import { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { z } from 'zod';
import { ok, fail } from '@/lib/server/http';
import { runAsSystem } from '@/lib/server/db';
import { engine } from '@/lib/server/engine/adapters';
import { lifecycle } from '@/lib/server/engine/graph';
import { getPolicy } from '@/lib/server/policy';
import { feedbackDue, openPortal, portalAccess, portalCookieName, saveFeedback } from '@/lib/server/client-portal';
import { devFeedbackGiven, isDevPortal } from '@/lib/server/dev-portal';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The client's rating from their portal: whatever the page is asking now (feedbackDue), once. A client who would recommend us is offered the firm's review page. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const body = z.object({ score: z.number().int().min(0).max(10), comment: z.string().max(2000).optional() }).parse(await req.json());
    if (isDevPortal(token)) {
      devFeedbackGiven();
      return ok({ saved: true, reviewUrl: body.score >= 4 ? 'https://www.reviewsolicitors.co.uk' : null });
    }
    const row = await openPortal(token);
    if (!row) throw Object.assign(new Error('This link no longer works.'), { status: 410 });
    if (!portalAccess(row.id, (await cookies()).get(portalCookieName(row.id))?.value)) throw Object.assign(new Error('Enter the code first.'), { status: 401 });
    const state = await runAsSystem(() => engine().getState(row.tenant_id, row.matter_id));
    const ask = await feedbackDue(row, lifecycle(state));
    if (!ask) return ok({ saved: false });
    await saveFeedback(row, ask, body.score, body.comment ?? null);
    const happy = ask.kind === 'nps' ? body.score >= 9 : body.score >= 4;
    const reviewUrl = happy && ask.kind === 'nps' ? await runAsSystem(() => getPolicy(row.tenant_id, 'reviewUrl')).catch(() => null) : null;
    return ok({ saved: true, reviewUrl });
  } catch (error) {
    return fail(error);
  }
}
