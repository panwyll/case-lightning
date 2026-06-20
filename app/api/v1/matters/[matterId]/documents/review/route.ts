import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { query, queryOne } from '@/lib/server/db';
import { assertMatterAccess } from '@/lib/server/guard';
import { getMessageAttachment, downloadDriveItem, appendTrackerRow } from '@/lib/server/graph';
import { reviewDocument, retrieveMatterContext, upsertChunks } from '@/lib/server/ai';
import { writeAudit } from '@/lib/server/audit';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Cap raw bytes so the base64-inflated payload (~+33%) stays under Anthropic's
// ~32 MB request limit for the document block.
const MAX_BYTES = 18 * 1024 * 1024;

const Body = z
  .object({
    messageId: z.string().optional(),
    attachmentId: z.string().optional(),
    documentId: z.string().uuid().optional(),
  })
  .refine((b) => b.documentId || (b.messageId && b.attachmentId), {
    message: 'Provide documentId, or messageId + attachmentId.',
  });

const isPdf = (mime: string, name: string) => /pdf/i.test(mime) || /\.pdf$/i.test(name);
const isText = (mime: string, name: string) => /^text\//i.test(mime) || /\.(txt|md|csv|eml)$/i.test(name);

export async function POST(req: NextRequest, { params }: { params: Promise<{ matterId: string }> }) {
  try {
    assertFeature('auth');
    assertFeature('graph');
    assertFeature('ai');
    const user = await requireUser();
    const { matterId } = z.object({ matterId: z.string().uuid() }).parse(await params);
    const body = Body.parse(await req.json());
    await assertMatterAccess(user, matterId);

    // ── Fetch the document bytes (email attachment OR a saved matter doc) ──────────
    let fileName = 'document';
    let mimeType = '';
    let pdfBase64: string | undefined;
    let documentText: string | undefined;
    let documentId: string | null = null;
    let graphMessageId: string | null = null;
    let graphAttachmentId: string | null = null;

    if (body.documentId) {
      const doc = await queryOne<{ id: string; graph_item_id: string | null; file_name: string; mime_type: string | null }>(
        `select id, graph_item_id, file_name, mime_type from document where id = $1 and matter_id = $2 and tenant_id = $3`,
        [body.documentId, matterId, user.tenantId]
      );
      if (!doc?.graph_item_id) return fail(new Error('Document not found or not stored in OneDrive.'));
      documentId = doc.id;
      fileName = doc.file_name;
      mimeType = doc.mime_type ?? '';
      const buf = await downloadDriveItem(user.userId, doc.graph_item_id);
      if (buf.length > MAX_BYTES) return fail(new Error('Document too large to review (max 18 MB).'));
      if (isPdf(mimeType, fileName)) pdfBase64 = buf.toString('base64');
      else if (isText(mimeType, fileName)) documentText = buf.toString('utf8');
      else return fail(new Error('Only PDF and plain-text documents can be reviewed in this version.'));
    } else {
      const att = await getMessageAttachment(user.userId, body.messageId!, body.attachmentId!);
      graphMessageId = body.messageId!;
      graphAttachmentId = body.attachmentId!;
      fileName = att.name ?? 'document';
      mimeType = att.contentType ?? '';
      if (!att.contentBytes) {
        return fail(new Error('That attachment has no readable content (it may be a linked/item attachment).'));
      }
      const buf = Buffer.from(att.contentBytes, 'base64');
      if (buf.length > MAX_BYTES) return fail(new Error('Document too large to review (max 18 MB).'));
      if (isPdf(mimeType, fileName)) pdfBase64 = att.contentBytes;
      else if (isText(mimeType, fileName)) documentText = buf.toString('utf8');
      else return fail(new Error('Only PDF and plain-text documents can be reviewed in this version.'));
    }

    // ── Build the matter's "expectations" the document is checked against ──────────
    const matter = await queryOne<{
      matter_ref: string;
      property_address: string;
      buyer_names: string[];
      seller_names: string[];
      counterparty_solicitor: string | null;
      counterparty_agent: string | null;
      lender: string | null;
      chain_position: string | null;
      exchange_target_date: string | null;
      completion_target_date: string | null;
      tracker_item_id: string | null;
    }>(
      `select matter_ref, property_address, buyer_names, seller_names, counterparty_solicitor, counterparty_agent,
              lender, chain_position, exchange_target_date, completion_target_date, tracker_item_id
       from matter where id = $1 and tenant_id = $2`,
      [matterId, user.tenantId]
    );
    const summary = await queryOne<{ facts: Record<string, unknown> }>(
      `select facts from matter_summary where matter_id = $1 and tenant_id = $2`,
      [matterId, user.tenantId]
    );
    const expectations = [
      `Matter ref: ${matter?.matter_ref ?? ''}`,
      `Property: ${matter?.property_address ?? ''}`,
      `Buyers: ${(matter?.buyer_names ?? []).join(', ') || 'unknown'}`,
      `Sellers: ${(matter?.seller_names ?? []).join(', ') || 'unknown'}`,
      matter?.counterparty_solicitor ? `Counterparty solicitor: ${matter.counterparty_solicitor}` : '',
      matter?.counterparty_agent ? `Estate agent: ${matter.counterparty_agent}` : '',
      matter?.lender ? `Lender: ${matter.lender}` : '',
      matter?.chain_position ? `Chain position: ${matter.chain_position}` : '',
      matter?.exchange_target_date ? `Target exchange: ${String(matter.exchange_target_date).slice(0, 10)}` : '',
      matter?.completion_target_date ? `Target completion: ${String(matter.completion_target_date).slice(0, 10)}` : '',
      `Known extracted facts: ${JSON.stringify(summary?.facts ?? {})}`,
    ]
      .filter(Boolean)
      .join('\n');

    const retrieved = await retrieveMatterContext({
      tenantId: user.tenantId,
      matterId,
      queryText: `Review document: ${fileName}`,
      includePlaybook: true,
      limit: 6,
    });
    const retrievedContext = retrieved.map((r) => `${r.source_kind}: ${r.chunk_text}`).join('\n---\n');

    // ── Review ─────────────────────────────────────────────────────────────────────
    const { review, model } = await reviewDocument({
      userId: user.userId,
      fileName,
      mimeType,
      pdfBase64,
      documentText,
      expectations,
      retrievedContext,
    });

    const mismatches = review.consistencyChecks.filter((c) => c.status === 'MISMATCH').length;
    const highRisks = review.risks.filter((r) => r.severity === 'HIGH').length;

    const inserted = await queryOne<{ id: string }>(
      `insert into document_review
        (tenant_id, matter_id, document_id, graph_message_id, graph_attachment_id, file_name, mime_type, review, model, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10) returning id`,
      [
        user.tenantId,
        matterId,
        documentId,
        graphMessageId,
        graphAttachmentId,
        fileName,
        mimeType || null,
        JSON.stringify(review),
        model,
        user.userId,
      ]
    );

    await query(
      `insert into matter_timeline_event (tenant_id, matter_id, event_type, title, details, source_ref)
       values ($1,$2,'DOCUMENT',$3,$4,$5::jsonb)`,
      [
        user.tenantId,
        matterId,
        `Reviewed: ${review.documentType}`,
        `${review.summary}${mismatches ? ` — ${mismatches} mismatch(es) flagged` : ''}`.slice(0, 1000),
        JSON.stringify({ reviewId: inserted!.id, fileName }),
      ]
    );

    if (matter?.tracker_item_id) {
      await appendTrackerRow(user.userId, matter.tracker_item_id, {
        date: new Date().toISOString().slice(0, 10),
        type: 'DOC_REVIEW',
        detail: `${review.documentType}: ${review.summary}`.slice(0, 250),
        owner: user.displayName ?? user.email,
        due: '',
        status: mismatches || highRisks ? 'OPEN' : 'NOTED',
      }).catch(() => {});
    }

    await upsertChunks({
      tenantId: user.tenantId,
      matterId,
      sourceKind: 'DOCUMENT',
      sourceId: documentId ?? undefined,
      text: `${review.documentType}\n${review.summary}\n${review.keyDetails.map((k) => `${k.label}: ${k.value}`).join('\n')}`,
      metadata: { fileName, source: 'REVIEW', reviewId: inserted!.id },
    }).catch(() => {});

    await writeAudit({
      tenantId: user.tenantId,
      matterId,
      actorUserId: user.userId,
      actionType: 'DOCUMENT_REVIEWED',
      actionStatus: 'SUCCESS',
      payload: { fileName, documentType: review.documentType, mismatches, highRisks, model },
    });

    return ok({ reviewId: inserted!.id, model, review });
  } catch (error) {
    return fail(error);
  }
}

/** Recent reviews for the matter (history). */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ matterId: string }> }) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const { matterId } = z.object({ matterId: z.string().uuid() }).parse(await params);
    await assertMatterAccess(user, matterId);
    const reviews = await query(
      `select id, file_name, mime_type, review, model, created_at
       from document_review where matter_id = $1 and tenant_id = $2 order by created_at desc limit 20`,
      [matterId, user.tenantId]
    );
    return ok({ reviews });
  } catch (error) {
    return fail(error);
  }
}
