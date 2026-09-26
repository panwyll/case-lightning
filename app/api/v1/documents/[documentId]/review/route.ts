import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertMatterAccess } from '@/lib/server/guard';
import { query, queryOne } from '@/lib/server/db';
import { ok, fail } from '@/lib/server/http';
import { writeAudit } from '@/lib/server/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The review table for one document: the page ledger and every fact with its quote, verification and any sign-off. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ documentId: string }> }) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const { documentId } = z.object({ documentId: z.string().uuid() }).parse(await params);
    const doc = await queryOne<{ matter_id: string; file_name: string | null; doc_type: string | null }>(`select matter_id, file_name, doc_type from document where id = $1 and tenant_id = $2`, [documentId, user.tenantId]);
    if (!doc) return fail(Object.assign(new Error('Document not found.'), { status: 404 }));
    await assertMatterAccess(user, doc.matter_id);
    const [pages, facts] = await Promise.all([
      query<{ page: number; verdict: string; text_chars: number }>(`select page, verdict, text_chars from document_page where document_id = $1 and tenant_id = $2 order by page`, [documentId, user.tenantId]),
      query<{ id: string; role: string; key: string; value: string; page: number | null; quote: string | null; verified: boolean; note: string | null; confirmed_at: string | null; confirmed_name: string | null; disputed_note: string | null }>(
        `select f.id, f.role, f.key, f.value, f.page, f.quote, f.verified, f.note, f.confirmed_at, coalesce(u.display_name, u.email) as confirmed_name, f.disputed_note from document_fact f left join app_user u on u.id = f.confirmed_by where f.document_id = $1 and f.tenant_id = $2 order by f.page nulls last, f.key`,
        [documentId, user.tenantId]
      ),
    ]);
    return ok({ document: { id: documentId, fileName: doc.file_name, docType: doc.doc_type }, pages, facts: facts.map((f) => ({ id: f.id, role: f.role, key: f.key, value: f.value, page: f.page, quote: f.quote, verified: f.verified, note: f.note, confirmedAt: f.confirmed_at, confirmedBy: f.confirmed_name, disputedNote: f.disputed_note })) });
  } catch (error) {
    return fail(error);
  }
}

/** Confirm or dispute one fact. A confirmed fact is a signed fact; a disputed one carries the reviewer's correction. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ documentId: string }> }) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const { documentId } = z.object({ documentId: z.string().uuid() }).parse(await params);
    const body = z.object({ factId: z.string().uuid(), action: z.enum(['confirm', 'dispute', 'clear']), note: z.string().max(1000).nullish() }).parse(await req.json());
    const doc = await queryOne<{ matter_id: string }>(`select matter_id from document where id = $1 and tenant_id = $2`, [documentId, user.tenantId]);
    if (!doc) return fail(Object.assign(new Error('Document not found.'), { status: 404 }));
    await assertMatterAccess(user, doc.matter_id);
    if (body.action === 'confirm') await query(`update document_fact set confirmed_by = $3, confirmed_at = now(), disputed_note = null where id = $1 and tenant_id = $2 and document_id = $4`, [body.factId, user.tenantId, user.userId, documentId]);
    else if (body.action === 'dispute') await query(`update document_fact set confirmed_by = null, confirmed_at = null, disputed_note = $3 where id = $1 and tenant_id = $2 and document_id = $4`, [body.factId, user.tenantId, body.note?.trim() || 'disputed', documentId]);
    else await query(`update document_fact set confirmed_by = null, confirmed_at = null, disputed_note = null where id = $1 and tenant_id = $2 and document_id = $3`, [body.factId, user.tenantId, documentId]);
    await writeAudit({ tenantId: user.tenantId, matterId: doc.matter_id, actorUserId: user.userId, actionType: 'FACT_REVIEWED', actionStatus: 'SUCCESS', payload: { documentId, factId: body.factId, action: body.action, note: body.note ?? null } }).catch(() => {});
    return ok({ saved: true });
  } catch (error) {
    return fail(error);
  }
}
