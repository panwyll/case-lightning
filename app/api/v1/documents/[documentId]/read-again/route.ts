import { NextRequest, after } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertMatterAccess } from '@/lib/server/guard';
import { ok, fail } from '@/lib/server/http';
import { query, queryOne } from '@/lib/server/db';
import { ingestFiledDocument } from '@/lib/server/engine/ingest-hook';
import { emitMatterEvent } from '@/lib/server/events';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Read a filed document again from scratch: the cached reading is dropped and the file goes
 * through classification and its sub-flow as if it had just arrived. For a report read before
 * the system asked the questions it asks now, or one read badly the first time.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ documentId: string }> }) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const { documentId } = z.object({ documentId: z.string().uuid() }).parse(await params);
    const row = await queryOne<{ matter_id: string }>(`select matter_id from document where id = $1 and tenant_id = $2`, [documentId, user.tenantId]);
    if (!row) return fail(Object.assign(new Error('Document not found.'), { status: 404 }));
    await assertMatterAccess(user, row.matter_id);
    // Drop the cached reading; the text of an engine-written document (its content) stays.
    await query(`update document set extracted_facts = case when extracted_facts ? 'content' then jsonb_build_object('content', extracted_facts->'content') else null end where id = $1 and tenant_id = $2`, [documentId, user.tenantId]);
    // A long report takes a minute or two to read: answer now, read after the response, log the outcome on the case.
    after(async () => {
      const report = await ingestFiledDocument(user.tenantId, row.matter_id, documentId).catch((e) => { console.error('[read-again] failed', (e as Error).message); return null; });
      const role = report?.classification?.role ?? null;
      const said = !report ? 'It could not be read.' : report.action.kind === 'skip' ? `Read${role && role !== 'other' ? ` as ${role.replace(/_/g, ' ')}` : ''}, not acted on: ${report.action.reason}` : `Read again as ${(role ?? report.action.kind).replace(/_/g, ' ')}.`;
      await emitMatterEvent({ tenantId: user.tenantId, matterId: row.matter_id, eventType: 'EMAIL_FILED', title: 'Read again', details: said }).catch(() => {});
    });
    return ok({ ok: true, said: 'Reading it again in the background.' });
  } catch (error) {
    return fail(error);
  }
}
