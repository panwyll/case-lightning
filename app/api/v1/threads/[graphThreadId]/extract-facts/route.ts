import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { query, queryOne } from '@/lib/server/db';
import { assertMatterAccess } from '@/lib/server/guard';
import { listThreadMessages, appendTrackerRow } from '@/lib/server/graph';
import { extractFacts, upsertChunks } from '@/lib/server/ai';
import { threadToText } from '@/lib/server/text';
import { writeAudit } from '@/lib/server/audit';
import { recordFigureChanges, factToStr, prettyLabel } from '@/lib/server/figure-audit';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: Promise<{ graphThreadId: string }> }) {
  try {
    assertFeature('auth');
    assertFeature('graph');
    assertFeature('ai');
    const user = await requireUser();
    const { graphThreadId } = await params;
    const body = z.object({ matterId: z.string().uuid().optional(), conversationId: z.string().optional() }).parse(await req.json());

    // A matter is optional. With one linked we persist the extraction into the
    // matter summary, timeline, RAG chunks and Excel tracker; without one we
    // still run the extraction and return it for display, but persist nothing
    // (there is nowhere to put it).
    if (body.matterId) await assertMatterAccess(user, body.matterId);
    const conversationId = body.conversationId ?? graphThreadId;
    const messages = await listThreadMessages(user.userId, conversationId);
    const text = threadToText(messages);
    const emailSubject = (messages[messages.length - 1]?.subject as string | undefined) ?? null;

    const existing = body.matterId
      ? await queryOne<{ facts: Record<string, unknown> }>(
          `select facts from matter_summary where matter_id = $1 and tenant_id = $2`,
          [body.matterId, user.tenantId]
        )
      : null;

    const extracted = await extractFacts({
      userId: user.userId,
      tenantId: user.tenantId,
      matterId: body.matterId ?? null,
      threadText: text,
      existingFacts: existing?.facts ?? {},
    });

    if (body.matterId) {
      await query(
        `update matter_summary set facts = $1::jsonb, outstanding_items = $2::jsonb, risks = $3::jsonb, updated_at = now()
         where matter_id = $4 and tenant_id = $5`,
        [
          JSON.stringify(extracted.facts),
          JSON.stringify(extracted.outstanding),
          JSON.stringify(extracted.risks),
          body.matterId,
          user.tenantId,
        ]
      );

      // Figure history: record which facts this email changed, with the email as the
      // source — so the House tab shows who/when/why for every figure.
      const oldFacts = (existing?.facts ?? {}) as Record<string, unknown>;
      const newFacts = extracted.facts as Record<string, unknown>;
      await recordFigureChanges({
        tenantId: user.tenantId,
        matterId: body.matterId,
        actorUserId: user.userId,
        source: 'AI_EMAIL',
        reason: emailSubject ? `Read from email: ${emailSubject}` : 'Read from an email',
        ref: { kind: 'EMAIL', id: graphThreadId, label: emailSubject },
        changes: Object.keys(newFacts).map((k) => ({
          field: k,
          label: prettyLabel(k),
          oldValue: factToStr(oldFacts[k]),
          newValue: factToStr(newFacts[k]),
        })),
      });

      for (const item of extracted.timeline) {
        await query(
          `insert into matter_timeline_event (tenant_id, matter_id, event_type, title, details, source_ref)
           values ($1,$2,'EMAIL',$3,$4,$5::jsonb)`,
          [user.tenantId, body.matterId, item.title, item.details, JSON.stringify({ graphThreadId })]
        );
      }

      await upsertChunks({
        tenantId: user.tenantId,
        matterId: body.matterId,
        sourceKind: 'EMAIL',
        text,
        metadata: { graphThreadId, conversationId },
      });

      // Reflect the freshly-extracted state into the user's Excel tracker.
      const matter = await queryOne<{ tracker_item_id: string | null }>(
        `select tracker_item_id from matter where id = $1 and tenant_id = $2`,
        [body.matterId, user.tenantId]
      );
      if (matter?.tracker_item_id) {
        const today = new Date().toISOString().slice(0, 10);
        for (const item of extracted.timeline) {
          await appendTrackerRow(user.userId, matter.tracker_item_id, {
            date: today,
            type: 'UPDATE',
            detail: `${item.title}: ${item.details}`.slice(0, 250),
            owner: '',
            due: '',
            status: 'NOTED',
          }).catch(() => {});
        }
        for (const o of extracted.outstanding) {
          await appendTrackerRow(user.userId, matter.tracker_item_id, {
            date: today,
            type: 'OUTSTANDING',
            detail: String(o).slice(0, 250),
            owner: '',
            due: '',
            status: 'OPEN',
          }).catch(() => {});
        }
      }
    }

    await writeAudit({
      tenantId: user.tenantId,
      matterId: body.matterId ?? null,
      actorUserId: user.userId,
      actionType: 'FACTS_EXTRACTED',
      actionStatus: 'SUCCESS',
      payload: { graphThreadId },
    });

    return ok(extracted);
  } catch (error) {
    return fail(error);
  }
}
