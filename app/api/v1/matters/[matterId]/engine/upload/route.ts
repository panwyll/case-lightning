import { NextRequest } from 'next/server';
import { z } from 'zod';
import crypto from 'node:crypto';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertMatterAccess } from '@/lib/server/guard';
import { query, queryOne } from '@/lib/server/db';
import { writeAudit } from '@/lib/server/audit';
import { ok, fail } from '@/lib/server/http';
import { engine, productionPorts } from '@/lib/server/engine/adapters';
import { ingestDocument, runAction, type IngestAction } from '@/lib/server/engine/ingest';
import { stageBlockers } from '@/lib/server/engine/machine';
import { pendingDecisions, SEARCH_TYPES } from '@/lib/server/engine/types';
import { requireWriter } from '@/lib/server/engine/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * File a document straight into the engine — no OneDrive needed. The bytes are kept in
 * document_blob (the same safety net the InfoTrack webhook uses), the extraction pipeline
 * reads them from there, and the document is routed into a sub-flow: an explicit `role`
 * when the caller knows what it is, otherwise the classifier (when configured).
 *
 * `facts` is an optional pre-extracted payload for environments without a model key —
 * it is written to document.extracted_facts exactly as pipeline #2 would.
 */
const bodySchema = z.object({
  fileName: z.string().min(1).max(200),
  base64: z.string().min(1),
  mimeType: z.string().max(100).default('application/pdf'),
  role: z.enum(['auto', 'search', 'enquiry_reply', 'mortgage_offer', 'title', 'id_check', 'management_pack']).default('auto'),
  searchType: z.enum(SEARCH_TYPES).optional(),
  enquiryId: z.string().max(60).optional(),
  facts: z.unknown().optional(),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ matterId: string }> }) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    requireWriter(user);
    const { matterId } = z.object({ matterId: z.string().uuid() }).parse(await params);
    await assertMatterAccess(user, matterId);
    const body = bodySchema.parse(await req.json());
    const bytes = Buffer.from(body.base64, 'base64');
    if (!bytes.length) throw Object.assign(new Error('Empty file.'), { status: 400 });
    if (bytes.length > 25 * 1024 * 1024) throw Object.assign(new Error('File too large (25 MB max).'), { status: 413 });

    const doc = await queryOne<{ id: string }>(
      `insert into document (tenant_id, matter_id, source_type, storage_path, file_name, mime_type, size_bytes, hash_sha256, doc_type, extracted_facts, extraction_confidence, created_by)
       values ($1,$2,'ENGINE_UPLOAD',$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11) returning id`,
      [
        user.tenantId,
        matterId,
        `engine-upload://${matterId}/${body.fileName}`,
        body.fileName,
        body.mimeType,
        bytes.length,
        crypto.createHash('sha256').update(bytes).digest('hex'),
        body.role === 'auto' ? null : body.role.toUpperCase(),
        body.facts === undefined ? null : JSON.stringify(body.facts),
        body.facts === undefined ? null : 1,
        user.userId,
      ]
    );
    await query(`insert into document_blob (document_id, tenant_id, bytes) values ($1,$2,$3)`, [doc!.id, user.tenantId, bytes]);

    const svc = engine();
    const ports = productionPorts();
    let action: IngestAction;
    let classification: unknown = null;
    if (body.role === 'auto') {
      const ref = await ports.documents.get(user.tenantId, doc!.id);
      const report = await ingestDocument(svc, ports, user.tenantId, matterId, ref!);
      action = report.action;
      classification = report.classification;
    } else if (body.role === 'search') {
      if (!body.searchType) throw Object.assign(new Error('searchType is required for a search result.'), { status: 400 });
      const state = await svc.getState(user.tenantId, matterId);
      action = { kind: 'search', searchType: body.searchType, recordOrderFirst: !state.searches[body.searchType] };
      await runAction(svc, user.tenantId, matterId, doc!.id, action);
    } else if (body.role === 'enquiry_reply') {
      if (!body.enquiryId) throw Object.assign(new Error('enquiryId is required for an enquiry reply.'), { status: 400 });
      action = { kind: 'enquiry_reply', enquiryId: body.enquiryId };
      await runAction(svc, user.tenantId, matterId, doc!.id, action);
    } else {
      action = { kind: body.role };
      await runAction(svc, user.tenantId, matterId, doc!.id, action);
    }
    const state = await svc.getState(user.tenantId, matterId);
    await writeAudit({ tenantId: user.tenantId, matterId, actorUserId: user.userId, actionType: 'ENGINE_UPLOAD', actionStatus: 'SUCCESS', payload: { documentId: doc!.id, fileName: body.fileName, role: body.role, action } }).catch(() => {});
    return ok({ documentId: doc!.id, action, classification, stage: state.stage, blockers: stageBlockers(state), pendingDecisions: pendingDecisions(state) });
  } catch (error) {
    return fail(error);
  }
}
