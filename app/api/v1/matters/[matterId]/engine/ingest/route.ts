import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertMatterAccess } from '@/lib/server/guard';
import { ok, fail } from '@/lib/server/http';
import { engine } from '@/lib/server/engine/adapters';
import { stageBlockers } from '@/lib/server/engine/machine';
import { pendingDecisions } from '@/lib/server/engine/types';
import { ingestSchema, requireWriter } from '@/lib/server/engine/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * A document has arrived for one of the engine's sub-flows. This is the manual
 * doorway that InfoTrack webhooks / mail ingestion will eventually call themselves:
 * the service runs the external-wait → extraction → rule-check → clear-or-flag pattern.
 * Extraction uses whatever pipeline #2 has put on `document.extracted_facts`; a
 * document with none is flagged for a human (never guessed).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ matterId: string }> }) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    requireWriter(user);
    const { matterId } = z.object({ matterId: z.string().uuid() }).parse(await params);
    await assertMatterAccess(user, matterId);
    const input = ingestSchema.parse(await req.json());
    const svc = engine();
    const t = user.tenantId;
    const result =
      input.role === 'search'
        ? await svc.searchReturned(t, matterId, input.searchType, input.documentId, input.provider ?? null)
        : input.role === 'enquiry_reply'
          ? await svc.enquiryReplyReceived(t, matterId, input.enquiryId, input.documentId)
          : input.role === 'mortgage_offer'
            ? await svc.mortgageOfferReceived(t, matterId, input.documentId)
            : input.role === 'title'
              ? await svc.titleReceived(t, matterId, input.documentId)
              : await svc.idCheckResultReceived(t, matterId, input.documentId);
    return ok({ events: result.events, stage: result.state.stage, blockers: stageBlockers(result.state), pendingDecisions: pendingDecisions(result.state) });
  } catch (error) {
    return fail(error);
  }
}
