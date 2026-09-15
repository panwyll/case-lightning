/**
 * The one-line hook other parts of the product call when a document lands on a matter
 * (files.ts, the InfoTrack webhook, mail attachment filing). Kept separate from
 * adapters.ts so importing it from files.ts doesn't drag the whole engine wiring into
 * every call site's module graph until it is actually used.
 */
import { engine, productionPorts } from './adapters';
import { ingestDocument, type IngestReport } from './ingest';
import { emitMatterEvent } from '../events';

export async function ingestFiledDocument(tenantId: string, matterId: string, documentId: string): Promise<IngestReport | null> {
  const ports = productionPorts();
  const doc = await ports.documents.get(tenantId, documentId);
  if (!doc) return null;
  const report = await ingestDocument(engine(), ports, tenantId, matterId, doc);
  if (report.action.kind === 'skip' && report.classification && report.classification.role !== 'other') {
    // Something recognisable arrived but could not be routed automatically — tell the
    // fee-earner, don't lose it (the /ingest route files it with an explicit role).
    await emitMatterEvent({
      tenantId,
      matterId,
      eventType: 'ENGINE_INGEST_SKIPPED',
      title: `Engine: ${report.classification.role.replace('_', ' ')} received but not filed automatically`,
      details: `${doc.fileName ?? documentId}: ${report.action.reason}`,
      notify: { kind: 'DOC_RECEIVED', headline: `${doc.fileName ?? 'A document'} needs filing into the engine`, did: `Read it as a ${report.classification.role.replace('_', ' ')} (${Math.round(report.classification.confidence * 100)}% sure)`, action: report.action.reason, dedupKey: `engine-ingest:${documentId}` },
    });
  }
  return report;
}
