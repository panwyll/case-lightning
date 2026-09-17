import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertMatterAccess } from '@/lib/server/guard';
import { ok, fail } from '@/lib/server/http';
import { engine } from '@/lib/server/engine/adapters';
import { requireDecider } from '@/lib/server/engine/http';
import { queryOne } from '@/lib/server/db';
import { writeAudit } from '@/lib/server/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The deliberate friction point: the handler must open the source document before
 * the resolve buttons work. This logs `decision_source_opened` (attributable) and
 * returns the document (url + any extracted content) for the UI to show.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ eventId: string }> }) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    requireDecider(user);
    const { eventId } = z.object({ eventId: z.string().uuid() }).parse(await params);
    const body = z.object({ documentId: z.string().uuid().optional() }).parse(await req.json().catch(() => ({})));
    const svc = engine();
    const d = await svc.eventStore.findDecision(user.tenantId, eventId);
    if (!d) return fail(Object.assign(new Error('Decision not found.'), { status: 404 }));
    await assertMatterAccess(user, d.matterId);
    const { document } = await svc.openDecisionSource(user.tenantId, d.matterId, eventId, user.userId, body.documentId ?? null);
    await writeAudit({ tenantId: user.tenantId, matterId: d.matterId, actorUserId: user.userId, actionType: 'ENGINE_DECISION_SOURCE_OPENED', actionStatus: 'SUCCESS', payload: { decisionEventId: eventId, documentId: document.id } }).catch(() => {});
    const content = (document.extractedFacts as { content?: string } | null)?.content ?? null;
    // Bytes we can serve inline: held locally (document_blob) or in LEAP (fetched on demand by the /raw route).
    const blob = await queryOne<{ ok: boolean }>(`select (exists (select 1 from document_blob b where b.document_id = d.id) or d.leap_document_id is not null) as ok from document d where d.id = $1`, [document.id]).catch(() => null);
    const rawUrl = blob?.ok ? `/api/v1/documents/${document.id}/raw` : null;
    return ok({ document: { id: document.id, fileName: document.fileName, webUrl: document.webUrl, docType: document.docType, content, rawUrl }, locator: d.sourceLocator ?? null });
  } catch (error) {
    return fail(error);
  }
}
