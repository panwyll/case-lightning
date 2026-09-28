/**
 * A signing provider reports back: the envelope was signed (with the signed copy), declined or
 * expired. Signed → the signed copy is filed and the deed recorded as signed, exactly as a
 * person recording a scan would; declined or expired → an execution issue for a person.
 * Authenticated by a shared secret per provider until each provider's own signature scheme is known.
 */
import crypto from 'node:crypto';
import { putBlob } from '../../blob-store';
import { z } from 'zod';
import { query, queryOne } from '../../db';
import { engine } from '../../engine/adapters';
import { EXTERNAL, SIGNED_DOCUMENT_LABEL, type SignedDocument } from '../../engine/types';

const Body = z.object({
  envelopeId: z.string().min(1).max(200),
  status: z.enum(['completed', 'declined', 'expired']),
  signedDocumentBase64: z.string().optional(),
  fileName: z.string().max(200).optional(),
  reason: z.string().max(500).optional(),
});

const CMD: Record<SignedDocument, 'transfer_deed_executed' | 'mortgage_deed_executed' | 'deed_of_trust_executed'> = { transfer: 'transfer_deed_executed', mortgage_deed: 'mortgage_deed_executed', deed_of_trust: 'deed_of_trust_executed' };

export async function handleSigningWebhook(provider: 'infotrack' | 'intouch' | 'leap', secretHeader: string | null, raw: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const secret = process.env[`${provider.toUpperCase()}_SIGNING_WEBHOOK_SECRET`];
  if (!secret) return { status: 503, body: { error: `${provider} e-signing is not connected.` } };
  if (!secretHeader || secretHeader.length !== secret.length || !crypto.timingSafeEqual(Buffer.from(secretHeader), Buffer.from(secret))) return { status: 401, body: { error: 'Bad signature.' } };
  const b = Body.parse(raw);
  const env = await queryOne<{ tenant_id: string; matter_id: string; document: SignedDocument }>(
    `select tenant_id, matter_id, payload->>'document' as document from matter_event where type = 'signing_envelope_sent' and payload->>'envelopeId' = $1 and payload->>'provider' = $2 order by seq desc limit 1`,
    [b.envelopeId, provider]
  );
  if (!env) return { status: 404, body: { error: 'Unknown envelope.' } };
  const svc = engine();
  if (b.status !== 'completed') {
    await svc.run(env.tenant_id, env.matter_id, { type: 'raise_issue', actor: EXTERNAL, kind: 'document_execution_problem', title: `${SIGNED_DOCUMENT_LABEL[env.document]}: electronic signature ${b.status}`, detail: `${b.reason ?? 'The signing provider reported it.'} Re-send it, or switch it to wet ink on the case.`, gate: 'completion' } as never);
    return { status: 200, body: { ok: true, recorded: b.status } };
  }
  if (!b.signedDocumentBase64) return { status: 400, body: { error: 'A completed envelope must carry the signed document.' } };
  const bytes = Buffer.from(b.signedDocumentBase64, 'base64');
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const name = b.fileName ?? `${SIGNED_DOCUMENT_LABEL[env.document]} (signed electronically).pdf`;
  const doc = await queryOne<{ id: string }>(
    `insert into document (tenant_id, matter_id, source_type, storage_path, file_name, mime_type, size_bytes, hash_sha256, doc_type)
     values ($1,$2,'E_SIGNATURE',$3,$4,'application/pdf',$5,$6,'SIGNED_DEED') returning id`,
    [env.tenant_id, env.matter_id, `esign://${provider}/${b.envelopeId}`, name, bytes.length, hash]
  );
  await putBlob(env.tenant_id, doc!.id, bytes);
  const state = await svc.getState(env.tenant_id, env.matter_id);
  await svc.run(env.tenant_id, env.matter_id, {
    type: CMD[env.document],
    actor: EXTERNAL,
    witnessed: true,
    ...(env.document !== 'mortgage_deed' ? { parties: state.partyNames?.length ? state.partyNames : ['the client'] } : {}),
    completion: { documentId: doc!.id, checklist: { witnessed: true, every_borrower: true, original_held: true }, party: null, note: `Signed electronically via ${provider}`, readDocument: null },
  } as never);
  return { status: 200, body: { ok: true, recorded: 'signed' } };
}
