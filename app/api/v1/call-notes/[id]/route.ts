import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertMatterAccess } from '@/lib/server/guard';
import { query, queryOne } from '@/lib/server/db';
import { upsertChunks } from '@/lib/server/ai';
import { uploadToMatterKb, matterKbPath } from '@/lib/server/graph';
import { emitMatterEvent } from '@/lib/server/events';
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

    const existing = await queryOne<{ id: string; matter_id: string | null; title: string; summary: string; transcript: string }>(
      `select id, matter_id, title, summary, transcript from call_note where id = $1 and tenant_id = $2 and user_id = $3`,
      [id, user.tenantId, user.userId]
    );
    if (!existing) return fail(Object.assign(new Error('Call note not found.'), { status: 404 }));

    if (body.matterId) await assertMatterAccess(user, body.matterId);

    const note = await queryOne(
      `update call_note set
         matter_id = case when $1::boolean then $2::uuid else matter_id end,
         title = coalesce($3, title),
         updated_at = now()
       where id = $4 and tenant_id = $5 returning ${COLS}`,
      [body.matterId !== undefined, body.matterId ?? null, body.title ?? null, id, user.tenantId]
    );

    // Newly attached to a matter → write a file into the matter's OneDrive Case Knowledge
    // Base, index it for RAG, and drop a timeline marker. Each step is best-effort.
    if (body.matterId && body.matterId !== existing.matter_id) {
      const title = body.title ?? existing.title;

      // A readable text file in the matter's OneDrive folder.
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
          await query(
            `insert into document (tenant_id, matter_id, source_type, drive_id, graph_item_id, storage_path, web_url, file_name, mime_type, doc_type, created_by)
             values ($1,$2,'CALL_NOTE',$3,$4,$5,$6,$7,'text/plain','CALL_NOTE',$8)`,
            [user.tenantId, body.matterId, uploaded.parentReference?.driveId ?? null, uploaded.id, `${matterKbPath(matter.folder_path)}/${fileName}`, uploaded.webUrl ?? null, fileName, user.userId]
          ).catch(() => {});
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
    await query(`delete from call_note where id = $1 and tenant_id = $2 and user_id = $3`, [id, user.tenantId, user.userId]);
    return ok({ deleted: true });
  } catch (error) {
    return fail(error);
  }
}
