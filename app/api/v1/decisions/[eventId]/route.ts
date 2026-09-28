import { effectText, noteTaskTitle } from '@/lib/server/engine/notes';
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertMatterAccess } from '@/lib/server/guard';
import { ok, fail } from '@/lib/server/http';
import { engine, productionPorts } from '@/lib/server/engine/adapters';
import { query, queryOne } from '@/lib/server/db';
import { SUBFLOW_OF_KIND, openPofQueries, type DecisionKind, type NoteAction, type Payloads } from '@/lib/server/engine/types';
import { ISSUE_KIND_SPEC } from '@/lib/server/engine/issues';
import { taskContext } from '@/lib/server/engine/context';
import { loadCrossChecks } from '@/lib/server/engine/crosscheck-run';
import { offeredOptions } from '@/lib/server/engine/rules';
import { previewProposal } from '@/lib/server/comms/preview';
import { clientOverview } from '@/lib/server/engine/client-overview';

type MatterRow = { matter_ref: string; property_address: string; shadow_mode: boolean | null; buyer_names: string[] | null; seller_names: string[] | null; purchase_price: string | null; lender: string | null; counterparty_solicitor: string | null; counterparty_agent: string | null; exchange_target_date: string | null; completion_target_date: string | null };

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
      svc.levels(user.tenantId),
      queryOne<MatterRow>(`select matter_ref, property_address, shadow_mode, buyer_names, seller_names, purchase_price::text, lender, counterparty_solicitor, counterparty_agent, exchange_target_date::text, completion_target_date::text from matter where id = $1 and tenant_id = $2`, [d.matterId, user.tenantId]).catch(() => null),
    ]);
    const raised = events.find((e) => e.id === eventId) ?? null;
    const resolving = events.find((e) => e.type !== 'decision_source_opened' && (e.payload as { decisionEventId?: string }).decisionEventId === eventId) ?? null;
    const escalation = events.find((e) => e.type === 'escalation_raised' && (e.payload as { origin?: { decisionEventId?: string } }).origin?.decisionEventId === eventId) ?? null;
    const opens = events.filter((e) => e.type === 'decision_source_opened' && (e.payload as { decisionEventId?: string }).decisionEventId === eventId).map((e) => ({ by: e.actor, at: e.createdAt, documentId: (e.payload as { documentId: string }).documentId }));
    const ids = Array.from(new Set([d.resolvedBy, resolving?.actor, ...opens.map((o) => o.by)].filter((x): x is string => !!x && /^[0-9a-f-]{36}$/i.test(x))));
    const people = ids.length ? await query<{ id: string; name: string }>(`select id, coalesce(display_name, email) as name from app_user where tenant_id = $1 and id = any($2::uuid[])`, [user.tenantId, ids]).catch(() => []) : [];
    const shadowed = null;
    let source: { id: string; fileName: string | null; webUrl: string | null; docType: string | null; content: string | null; rawUrl: string | null; draftCheck?: unknown } | null = null;
    if (d.status !== 'pending') {
      const doc = await svc.getDocument(user.tenantId, d.matterId, d.sourceDocumentId);
      if (doc) {
        const blob = await queryOne<{ ok: boolean; draft_check: unknown }>(`select (exists (select 1 from document_blob b where b.document_id = d.id) or d.leap_document_id is not null) as ok, d.draft_check from document d where d.id = $1`, [doc.id]).catch(() => null);
        source = { id: doc.id, fileName: doc.fileName, webUrl: doc.webUrl, docType: doc.docType, content: (doc.extractedFacts as { content?: string } | null)?.content ?? null, rawUrl: blob?.ok ? `/api/v1/documents/${doc.id}/raw` : null, draftCheck: blob?.draft_check ?? null };
      }
    }
    // A note's decision is a list of lines, not one verdict: the panel needs each
    // proposal, the words it came from, and what it would do (docs/intake.md).
    let noteActions = null as null | Record<string, unknown>;
    if (d.kind === 'note_actions' && raised?.type === 'note_extracted') {
      const p = raised.payload as Payloads['note_extracted'];
      const state = await svc.getState(user.tenantId, d.matterId);
      const note = state.notes[p.noteId] ?? null;
      const applied = resolving?.type === 'note_actions_applied' ? (resolving.payload as Payloads['note_actions_applied']) : null;
      noteActions = {
        title: noteTaskTitle(p.actions),
        noteId: p.noteId,
        noteKind: note?.kind ?? 'typed',
        actions: p.actions.map((a: NoteAction) => ({
          id: a.id,
          kind: a.kind,
          summary: a.summary,
          quote: a.quote,
          confidence: a.confidence,
          effect: a.command ? effectText(a.command) : null,
        })),
        applied: applied?.applied ?? null,
        skipped: applied?.skipped ?? null,
        refused: note?.refusedActions ?? [],
      };
    }
    const [pageRow, factRows] = await Promise.all([
      queryOne<{ pages: string; read: string; with_facts: string; unreadable: string; unattested: string; text_chars: string }>(`select count(*)::text as pages, count(*) filter (where verdict <> 'unattested')::text as read, count(*) filter (where verdict = 'facts')::text as with_facts, count(*) filter (where verdict = 'unreadable')::text as unreadable, count(*) filter (where verdict = 'unattested')::text as unattested, coalesce(sum(text_chars), 0)::text as text_chars from document_page where tenant_id = $1 and document_id = $2`, [user.tenantId, d.sourceDocumentId]).catch(() => null),
      query<{ key: string; value: string; verified: boolean; note: string | null }>(`select key, value, verified, note from document_fact where tenant_id = $1 and document_id = $2 order by verified, key`, [user.tenantId, d.sourceDocumentId]).catch(() => []),
    ]);
    const review = pageRow && Number(pageRow.pages) > 0 ? { pages: Number(pageRow.pages), read: Number(pageRow.read), withFacts: Number(pageRow.with_facts), unreadable: Number(pageRow.unreadable), unattested: Number(pageRow.unattested), complete: Number(pageRow.unattested) === 0, facts: factRows.length, verified: factRows.filter((f) => f.verified).length, textLayer: Number(pageRow.text_chars) > 20, unverified: factRows.filter((f) => !f.verified).map((f) => ({ key: f.key, value: f.value, note: f.note })) } : null;
    const crosschecks = await loadCrossChecks(user.tenantId, d.matterId);
    const stateForContext = await svc.getState(user.tenantId, d.matterId);
    const live = stateForContext.decisions[eventId];
    // Proof of funds: the statements as read, so the brief can point at the salary lines and the gift arriving.
    const statementFacts = live?.kind === 'proof_of_funds'
      ? (await Promise.all((stateForContext.proofOfFunds.statements ?? []).filter((st) => st.readable).map(async (st) => { const doc = await productionPorts().documents.get(user.tenantId, st.documentId).catch(() => null); const f = doc?.extractedFacts as { transactions?: unknown[]; salaryCredits?: unknown[] } | null; return f && Array.isArray(f.transactions) ? { documentId: st.documentId, fileName: doc?.fileName ?? st.fileName, facts: f as never } : null; }))).filter((x): x is NonNullable<typeof x> => !!x)
      : [];
    const context = live
      ? taskContext({ state: stateForContext, events, target: { kind: 'decision', decision: live }, review, statementFacts, crosschecks, matter: { matterRef: matter?.matter_ref ?? null, propertyAddress: matter?.property_address ?? null, buyerNames: matter?.buyer_names, sellerNames: matter?.seller_names, purchasePrice: matter?.purchase_price, lender: matter?.lender, counterpartySolicitor: matter?.counterparty_solicitor, counterpartyAgent: matter?.counterparty_agent, exchangeTargetDate: matter?.exchange_target_date, completionTargetDate: matter?.completion_target_date } })
      : null;
    // A proposal is decided on what it would actually send or do: the exact message, form or order.
    let message = null as Awaited<ReturnType<typeof previewProposal>>;
    if (d.kind === 'proposal') {
      const pr = Object.values(stateForContext.proposals).find((x) => x.eventId === eventId) ?? null;
      if (pr) message = await previewProposal(user.tenantId, d.matterId, pr.action, (pr.detail ?? {}) as Record<string, unknown>, { overview: clientOverview(stateForContext, new Date()).text }).catch(() => null);
    }
    return ok({
      context,
      noteActions,
      message,
      openQueries: d.kind === 'proof_of_funds' ? openPofQueries(stateForContext).length : 0,
      decision: { ...d, options: offeredOptions(d.kind, d.options), sourceOpenedByMe: d.openedBy.includes(user.userId) },
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
