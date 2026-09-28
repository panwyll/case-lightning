import { NextRequest, after } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertMatterAccess } from '@/lib/server/guard';
import { ok, fail } from '@/lib/server/http';
import { query, queryOne } from '@/lib/server/db';
import { ingestFiledDocument } from '@/lib/server/engine/ingest-hook';
import { engine } from '@/lib/server/engine/adapters';
import { emitMatterEvent } from '@/lib/server/events';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** The event a reading left, and the role it means. */
const ROLE_OF_EVENT: Record<string, 'search' | 'enquiry_reply' | 'mortgage_offer' | 'title' | 'id_check' | 'contract' | 'survey' | 'specialist_report' | 'management_pack' | 'lease' | 'property_forms'> = {
  survey_received: 'survey',
  specialist_report_received: 'specialist_report',
  search_returned: 'search',
  search_extracted: 'search',
  enquiry_reply_received: 'enquiry_reply',
  mortgage_offer_received: 'mortgage_offer',
  title_extracted: 'title',
  lease_extracted: 'lease',
  management_pack_received: 'management_pack',
  property_forms_received: 'property_forms',
  seller_forms_received: 'property_forms',
  id_check_cleared: 'id_check',
  id_check_flagged: 'id_check',
};

/**
 * Read a filed document again from scratch: the cached reading is dropped and the file goes
 * through classification and its sub-flow as if it had just arrived. For a report read before
 * the system asked the questions it asks now, or one read badly the first time.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ documentId: string }> }) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const { documentId } = z.object({ documentId: z.string().uuid() }).parse(await params);
    // Read it again, and (a person's choice) replace the tasks it produced with new ones.
    const { replaceTasks } = z.object({ replaceTasks: z.boolean().default(false) }).parse(await req.json().catch(() => ({})));
    const row = await queryOne<{ matter_id: string }>(`select matter_id from document where id = $1 and tenant_id = $2`, [documentId, user.tenantId]);
    if (!row) return fail(Object.assign(new Error('Document not found.'), { status: 404 }));
    await assertMatterAccess(user, row.matter_id);
    // One read at a time: a second press while the first is running starts nothing (and costs nothing).
    const claimed = await queryOne<{ id: string }>(
      `update document set read_again_at = now() where id = $1 and tenant_id = $2 and (read_again_at is null or read_again_at < now() - interval '5 minutes') returning id`,
      [documentId, user.tenantId]
    ).catch(() => ({ id: documentId })); // before migration 101 the column is missing: no lock, still works
    if (!claimed) return fail(Object.assign(new Error('Already being read.'), { status: 409 }));
    // What it was read as last time: read it as that again, without paying to classify it again.
    const last = await queryOne<{ type: string; payload: Record<string, unknown> }>(
      `select type, payload from matter_event where tenant_id = $1 and matter_id = $2 and source_document_id = $3 and type = any($4::text[]) order by seq desc limit 1`,
      [user.tenantId, row.matter_id, documentId, Object.keys(ROLE_OF_EVENT)]
    ).catch(() => null);
    const known = last ? { role: ROLE_OF_EVENT[last.type], searchType: (last.payload.searchType as never) ?? null, enquiryReferences: typeof last.payload.enquiryId === 'string' ? [last.payload.enquiryId] : [], titleNumber: null, lender: null, confidence: 1, reason: 'read again as what it was read as before' } : null;
    // Drop the cached reading; the text of an engine-written document (its content) stays.
    await query(`update document set extracted_facts = case when extracted_facts ? 'content' then jsonb_build_object('content', extracted_facts->'content') else null end where id = $1 and tenant_id = $2`, [documentId, user.tenantId]);
    // A long report takes a minute or two to read: answer now, read after the response, log the outcome on the case.
    after(async () => {
      const report = await ingestFiledDocument(user.tenantId, row.matter_id, documentId, known).catch((e) => { console.error('[read-again] failed', (e as Error).message); return null; });
      await query(`update document set read_again_at = null where id = $1 and tenant_id = $2`, [documentId, user.tenantId]).catch(() => {});
      if (replaceTasks && report?.classification?.role === 'survey') await engine().sendSurveyRecommendations(user.tenantId, row.matter_id, documentId).catch((e) => console.error('[read-again] recommendations failed', (e as Error).message));
      const role = report?.classification?.role ?? null;
      const said = !report ? 'It could not be read.' : report.action.kind === 'skip' ? `Read${role && role !== 'other' ? ` as ${role.replace(/_/g, ' ')}` : ''}, not acted on: ${report.action.reason}` : `Read again as ${(role ?? report.action.kind).replace(/_/g, ' ')}.`;
      await emitMatterEvent({ tenantId: user.tenantId, matterId: row.matter_id, eventType: 'EMAIL_FILED', title: 'Read again', details: said }).catch(() => {});
    });
    return ok({ ok: true, said: 'Reading…' });
  } catch (error) {
    return fail(error);
  }
}
