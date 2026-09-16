import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertMatterAccess } from '@/lib/server/guard';
import { ok, fail } from '@/lib/server/http';
import { engine } from '@/lib/server/engine/adapters';
import { query, queryOne } from '@/lib/server/db';
import { SUBFLOW_OF_KIND, type DecisionKind } from '@/lib/server/engine/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * One decision for the panel (addendum 3 §3): the decision itself, the resolving event
 * (option, reason, engagement, who, when) when it has been resolved, the names behind
 * the ids, and — for a RESOLVED decision — the source for read-only display. A pending
 * decision's source comes from POST ./open-source, which logs the opening.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ eventId: string }> }) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const { eventId } = z.object({ eventId: z.string().uuid() }).parse(await params);
    const svc = engine();
    const d = await svc.eventStore.findDecision(user.tenantId, eventId);
    if (!d) return fail(Object.assign(new Error('Decision not found.'), { status: 404 }));
    await assertMatterAccess(user, d.matterId);
    const [events, subflows, matter] = await Promise.all([
      svc.listEvents(user.tenantId, d.matterId),
      svc.subflows(user.tenantId),
      queryOne<{ matter_ref: string; property_address: string; shadow_mode: boolean | null }>(`select matter_ref, property_address, shadow_mode from matter where id = $1 and tenant_id = $2`, [d.matterId, user.tenantId]).catch(() => null),
    ]);
    const raised = events.find((e) => e.id === eventId) ?? null;
    const resolving = events.find((e) => e.type !== 'decision_source_opened' && (e.payload as { decisionEventId?: string }).decisionEventId === eventId) ?? null;
    const escalation = events.find((e) => e.type === 'escalation_raised' && (e.payload as { origin?: { decisionEventId?: string } }).origin?.decisionEventId === eventId) ?? null;
    const opens = events.filter((e) => e.type === 'decision_source_opened' && (e.payload as { decisionEventId?: string }).decisionEventId === eventId).map((e) => ({ by: e.actor, at: e.createdAt, documentId: (e.payload as { documentId: string }).documentId }));
    const ids = Array.from(new Set([d.resolvedBy, resolving?.actor, ...opens.map((o) => o.by)].filter((x): x is string => !!x && /^[0-9a-f-]{36}$/i.test(x))));
    const people = ids.length ? await query<{ id: string; name: string }>(`select id, coalesce(display_name, email) as name from app_user where tenant_id = $1 and id = any($2::uuid[])`, [user.tenantId, ids]).catch(() => []) : [];
    const sf = SUBFLOW_OF_KIND[d.kind as DecisionKind];
    const shadowed = !!(matter?.shadow_mode || d.shadowMode) ? 'matter' : sf && subflows[sf] === 'shadow' ? 'subflow' : null;
    let source: { id: string; fileName: string | null; webUrl: string | null; docType: string | null; content: string | null; rawUrl: string | null } | null = null;
    if (d.status !== 'pending') {
      const doc = await svc.getDocument(user.tenantId, d.matterId, d.sourceDocumentId);
      if (doc) {
        const blob = await queryOne<{ ok: boolean }>(`select true as ok from document_blob where document_id = $1`, [doc.id]).catch(() => null);
        source = { id: doc.id, fileName: doc.fileName, webUrl: doc.webUrl, docType: doc.docType, content: (doc.extractedFacts as { content?: string } | null)?.content ?? null, rawUrl: blob ? `/api/v1/documents/${doc.id}/raw` : null };
      }
    }
    return ok({
      decision: { ...d, sourceOpenedByMe: d.openedBy.includes(user.userId) },
      matter: matter ? { matterRef: matter.matter_ref, propertyAddress: matter.property_address, shadowMode: !!matter.shadow_mode } : null,
      raised: raised ? { seq: raised.seq, type: raised.type, actor: raised.actor, createdAt: raised.createdAt, confidenceScore: raised.confidenceScore } : null,
      resolution: resolving
        ? { eventId: resolving.id, type: resolving.type, by: resolving.actor, at: resolving.createdAt, option: (resolving.payload as { option?: string }).option ?? d.resolution, note: (resolving.payload as { note?: string | null }).note ?? null, engagement: (resolving.payload as { engagement?: unknown }).engagement ?? null, verification: (resolving.payload as { method?: string; reference?: string | null }).method ? { method: (resolving.payload as { method: string }).method, reference: (resolving.payload as { reference?: string | null }).reference ?? null } : null }
        : null,
      escalation: escalation ? { eventId: escalation.id, at: escalation.createdAt } : null,
      opens,
      people: Object.fromEntries(people.map((p) => [p.id, p.name])),
      shadowed,
      source,
    });
  } catch (error) {
    return fail(error);
  }
}
