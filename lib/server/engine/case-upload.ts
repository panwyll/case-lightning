/**
 * Filing a document straight into the engine, whichever way its bytes arrived (in the request,
 * or straight into storage for a file too big to pass through the web server): the row, then the
 * route into a sub-flow: an explicit role when the caller knows what it is, otherwise the
 * classifier; 'evidence' is filed as it is, never read or routed.
 */
import crypto from 'node:crypto';
import { z } from 'zod';
import { queryOne } from '../db';
import { writeAudit } from '../audit';
import { engine, productionPorts } from './adapters';
import { ingestDocument, runAction, type IngestAction } from './ingest';
import { stageBlockers } from './machine';
import { pendingDecisions, SEARCH_TYPES } from './types';
import type { SessionUser } from '../types';

export const UploadRoutingSchema = z.object({
  fileName: z.string().min(1).max(200),
  mimeType: z.string().max(100).default('application/pdf'),
  role: z.enum(['auto', 'evidence', 'search', 'enquiry_reply', 'mortgage_offer', 'title', 'id_check', 'management_pack', 'lease', 'survey', 'specialist_report', 'property_forms']).default('auto'),
  /** id_check: whose result this is (a party id from the case); blank = the first client */
  party: z.string().max(80).nullish(),
  searchType: z.enum(SEARCH_TYPES).optional(),
  enquiryId: z.string().max(60).optional(),
  facts: z.unknown().optional(),
});
export type UploadRouting = z.infer<typeof UploadRoutingSchema>;

/** The document row for an upload; the hash and size are known when the bytes are (later, for a direct upload). */
export async function createUploadDocument(user: SessionUser, matterId: string, body: UploadRouting, bytes: Buffer | null, size: number | null = null): Promise<string> {
  const doc = await queryOne<{ id: string }>(
    `insert into document (tenant_id, matter_id, source_type, storage_path, file_name, mime_type, size_bytes, hash_sha256, doc_type, extracted_facts, extraction_confidence, created_by)
     values ($1,$2,'ENGINE_UPLOAD',$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11) returning id`,
    [
      user.tenantId,
      matterId,
      `engine-upload://${matterId}/${body.fileName}`,
      body.fileName,
      body.mimeType,
      bytes ? bytes.length : size,
      bytes ? crypto.createHash('sha256').update(bytes).digest('hex') : null,
      body.role === 'auto' ? null : body.role === 'evidence' ? 'MANUAL_EVIDENCE' : body.role.toUpperCase(),
      body.facts === undefined ? null : JSON.stringify(body.facts),
      body.facts === undefined ? null : 1,
      user.userId,
    ]
  );
  return doc!.id;
}

/** Route a filed upload into the engine; the answer the upload screens show. */
export async function routeUpload(user: SessionUser, matterId: string, documentId: string, body: UploadRouting) {
  const svc = engine();
  const ports = productionPorts();
  let action: IngestAction;
  let classification: unknown = null;
  if (body.role === 'evidence') {
    const state = await svc.getState(user.tenantId, matterId);
    await writeAudit({ tenantId: user.tenantId, matterId, actorUserId: user.userId, actionType: 'ENGINE_UPLOAD', actionStatus: 'SUCCESS', payload: { documentId: documentId, fileName: body.fileName, role: 'evidence' } }).catch(() => {});
    return ({ documentId: documentId, action: { kind: 'skip', reason: 'filed as evidence' }, classification: null, stage: state.stage, blockers: stageBlockers(state), pendingDecisions: pendingDecisions(state) });
  }
  if (body.role === 'auto') {
    const ref = await ports.documents.get(user.tenantId, documentId);
    const report = await ingestDocument(svc, ports, user.tenantId, matterId, ref!);
    action = report.action;
    classification = report.classification;
  } else if (body.role === 'search') {
    if (!body.searchType) throw Object.assign(new Error('searchType is required for a search result.'), { status: 400 });
    const state = await svc.getState(user.tenantId, matterId);
    action = { kind: 'search', searchType: body.searchType, recordOrderFirst: !state.searches[body.searchType] };
    await runAction(svc, user.tenantId, matterId, documentId, action);
  } else if (body.role === 'enquiry_reply') {
    if (!body.enquiryId) throw Object.assign(new Error('enquiryId is required for an enquiry reply.'), { status: 400 });
    action = { kind: 'enquiry_reply', enquiryId: body.enquiryId };
    await runAction(svc, user.tenantId, matterId, documentId, action);
  } else if (body.role === 'id_check') {
    action = { kind: 'id_check', party: body.party ?? null };
    await runAction(svc, user.tenantId, matterId, documentId, action);
  } else if (body.role === 'specialist_report') {
    const state = await svc.getState(user.tenantId, matterId);
    const open = Object.values(state.issues).filter((i) => i.kind === 'survey_further_investigation' && (i.status === 'open' || i.status === 'negotiating'));
    action = { kind: 'specialist_report', forIssueId: open.length === 1 ? open[0].id : null };
    await runAction(svc, user.tenantId, matterId, documentId, action);
  } else {
    action = { kind: body.role };
    await runAction(svc, user.tenantId, matterId, documentId, action);
  }
  const state = await svc.getState(user.tenantId, matterId);
  await writeAudit({ tenantId: user.tenantId, matterId, actorUserId: user.userId, actionType: 'ENGINE_UPLOAD', actionStatus: 'SUCCESS', payload: { documentId: documentId, fileName: body.fileName, role: body.role, action } }).catch(() => {});
  return ({ documentId: documentId, action, classification, stage: state.stage, blockers: stageBlockers(state), pendingDecisions: pendingDecisions(state) });
}
