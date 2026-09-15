import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertMatterAccess } from '@/lib/server/guard';
import { ok, fail } from '@/lib/server/http';
import { engine } from '@/lib/server/engine/adapters';
import { requireDecider } from '@/lib/server/engine/http';

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
    const content = (document.extractedFacts as { content?: string } | null)?.content ?? null;
    return ok({ document: { id: document.id, fileName: document.fileName, webUrl: document.webUrl, docType: document.docType, content }, locator: d.sourceLocator ?? null });
  } catch (error) {
    return fail(error);
  }
}
