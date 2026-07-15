import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertMatterAccess } from '@/lib/server/guard';
import { query, queryOne } from '@/lib/server/db';
import { upsertChunks } from '@/lib/server/ai';
import { uploadToMatterKb, matterKbPath, deleteDriveItem } from '@/lib/server/graph';
import { emitMatterEvent } from '@/lib/server/events';
import { writeAudit } from '@/lib/server/audit';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const COLS = `id, matter_id, title, summary, transcript, duration_seconds, created_at,
  (select matter_ref from matter m where m.id = call_note.matter_id) as matter_ref`;

/** Assign a call note to a matter (indexing it into that matter's knowledge base) and/or rename it. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const { id } = z.object({ id: z.string().uuid() }).parse(await params);
    const body = z
      .object({ matterId: z.string().uuid().nullable().optional(), title: z.string().max(200).optional() })
      .parse(await req.json());

    const existing = await queryOne<{ id: string; matter_id: string | null; title: string; summary: string; transcript: string; document_id: string | null; drive_item_id: string | null }>(
      `select id, matter_id, title, summary, transcript, document_id, drive_item_id from call_note where id = $1 and tenant_id = $2 and user_id = $3`,
      [id, user.tenantId, user.userId]
    );
    if (!existing) return fail(Object.assign(new Error('Call note not found.'), { status: 404 }));

    if (body.matterId) await assertMatterAccess(user, body.matterId);

    const changingMatter = body.matterId !== undefined && (body.matterId ?? null) !== (existing.matter_id ?? null);

    // Moving or un-assigning: purge everything this note left on the OLD matter — its KB
    // chunks, its OneDrive file, and its document row — so no confidential residue remains
    // where it doesn't belong. Best-effort per step; then clear the tracked artifact ids.
    if (changingMatter && existing.matter_id) {
      await query(`delete from kb_chunk where tenant_id = $1 and matter_id = $2 and source_id = $3`, [user.tenantId, existing.matter_id, existing.id]).catch(() => {});
      if (existing.drive_item_id) await deleteDriveItem(user.userId, existing.drive_item_id).catch(() => {});
      if (existing.document_id) await query(`delete from document where id = $1 and tenant_id = $2`, [existing.document_id, user.tenantId]).catch(() => {});
      await emitMatterEvent({ tenantId: user.tenantId, matterId: existing.matter_id, eventType: 'CALL_NOTE_REMOVED', title: `Call note removed: ${existing.title}` }).catch(() => {});
      await writeAudit({ tenantId: user.tenantId, actorUserId: user.userId, matterId: existing.matter_id, actionType: 'CALL_NOTE_UNASSIGNED', actionStatus: 'SUCCESS', payload: { callNoteId: existing.id, movedTo: body.matterId ?? null } }).catch(() => {});
      await query(`update call_note set document_id = null, drive_item_id = null where id = $1 and tenant_id = $2`, [existing.id, user.tenantId]).catch(() => {});
    }

    const note = await queryOne(
      `update call_note set
         matter_id = case when $1::boolean then $2::uuid else matter_id end,
         title = coalesce($3, title),
         updated_at = now()
       where id = $4 and tenant_id = $5 returning ${COLS}`,
      [body.matterId !== undefined, body.matterId ?? null, body.title ?? null, id, user.tenantId]
    );

    // Newly attached to a matter → write a file into the matter's OneDrive Case Knowledge
    // Base, index it for RAG, and drop a timeline marker. Track the file/doc ids so a later
    // move can clean them up. Each step is best-effort.
    if (body.matterId && changingMatter) {
      const title = body.title ?? existing.title;
      try {
        const matter = await queryOne<{ folder_path: string | null }>(
          `select folder_path from matter where id = $1 and tenant_id = $2`,
          [body.matterId, user.tenantId]
        );
        if (matter?.folder_path) {
          const dateStr = new Date().toISOString().slice(0, 10);
          const safeTitle = (title || 'Call note').replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
          const fileName = `Call note — ${safeTitle} — ${dateStr}.txt`;
          const content = `Call note: ${title}\nDate: ${new Date().toLocaleString('en-GB')}\n\nSUMMARY\n${existing.summary || '(none)'}\n\nFULL TRANSCRIPT\n${existing.transcript || '(none)'}\n`;
          const uploaded = await uploadToMatterKb(user.userId, matter.folder_path, fileName, Buffer.from(content, 'utf8'));
          const doc = await queryOne<{ id: string }>(
            `insert into document (tenant_id, matter_id, source_type, drive_id, graph_item_id, storage_path, web_url, file_name, mime_type, doc_type, created_by)
             values ($1,$2,'CALL_NOTE',$3,$4,$5,$6,$7,'text/plain','CALL_NOTE',$8) returning id`,
            [user.tenantId, body.matterId, uploaded.parentReference?.driveId ?? null, uploaded.id, `${matterKbPath(matter.folder_path)}/${fileName}`, uploaded.webUrl ?? null, fileName, user.userId]
          ).catch(() => null);
          await query(`update call_note set document_id = $1, drive_item_id = $2 where id = $3 and tenant_id = $4`, [doc?.id ?? null, uploaded.id ?? null, existing.id, user.tenantId]).catch(() => {});
        }
      } catch { /* OneDrive write is best-effort — the KB index + timeline still land */ }

      await upsertChunks({
        tenantId: user.tenantId,
        matterId: body.matterId,
        sourceKind: 'DOCUMENT',
        sourceId: existing.id,
        text: `Call note: ${title}\nSummary: ${existing.summary}\nTranscript: ${existing.transcript}`,
        metadata: { source: 'CALL_NOTE', callNoteId: existing.id, title },
      }).catch(() => {});
      await emitMatterEvent({
        tenantId: user.tenantId,
        matterId: body.matterId,
        eventType: 'CALL_NOTE',
        title: `Call note added: ${title}`,
        details: existing.summary || null,
      }).catch(() => {});
    }

    return ok({ note });
  } catch (error) {
    return fail(error);
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const { id } = z.object({ id: z.string().uuid() }).parse(await params);
    // Clean up anything it filed to a matter before removing the note itself.
    const n = await queryOne<{ matter_id: string | null; document_id: string | null; drive_item_id: string | null }>(
      `select matter_id, document_id, drive_item_id from call_note where id = $1 and tenant_id = $2 and user_id = $3`,
      [id, user.tenantId, user.userId]
    );
    if (n?.matter_id) {
      await query(`delete from kb_chunk where tenant_id = $1 and matter_id = $2 and source_id = $3`, [user.tenantId, n.matter_id, id]).catch(() => {});
      if (n.drive_item_id) await deleteDriveItem(user.userId, n.drive_item_id).catch(() => {});
      if (n.document_id) await query(`delete from document where id = $1 and tenant_id = $2`, [n.document_id, user.tenantId]).catch(() => {});
    }
    await query(`delete from call_note where id = $1 and tenant_id = $2 and user_id = $3`, [id, user.tenantId, user.userId]);
    return ok({ deleted: true });
  } catch (error) {
    return fail(error);
  }
}
