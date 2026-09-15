/**
 * Component #2, the front door: a document has been filed on a matter — work out what
 * it is and hand it to the right engine sub-flow.
 *
 *   document filed (OneDrive upload, email attachment, InfoTrack webhook, manual)
 *     → classify (ClaudeExtractor.classify, or the explicit role a caller supplied)
 *     → routeClassification (PURE: given the matter's state, what should happen?)
 *     → EngineService sub-flow (searchReturned / enquiryReplyReceived / …)
 *
 * The routing function is deterministic and unit-tested; it never invents state. A
 * search result for a search the log doesn't show as ordered is recorded as a manual
 * order first (actor 'external', provider 'document arrived') so the log stays truthful.
 * A reply that can't be matched to exactly one open enquiry is NOT guessed — it is
 * reported for a human to file with the /ingest route.
 */
import { MIN_EXTRACTION_CONFIDENCE } from './rules';
import type { EngineService, RunResult } from './service';
import type { DocumentClassification, DocumentRef, EnginePorts } from './ports';
import type { MatterState, SearchType } from './types';
import { EXTERNAL } from './types';
import { referencesMatch } from './extraction';

/** Below this the classifier's verdict is not acted on automatically. */
export const MIN_CLASSIFICATION_CONFIDENCE = 0.8;

export type IngestAction =
  | { kind: 'search'; searchType: SearchType; recordOrderFirst: boolean }
  | { kind: 'enquiry_reply'; enquiryId: string }
  | { kind: 'mortgage_offer' }
  | { kind: 'title' }
  | { kind: 'id_check' }
  | { kind: 'skip'; reason: string };

/** Pure: decide what to do with a classified document given the matter's projected state. */
export function routeClassification(state: MatterState, c: DocumentClassification): IngestAction {
  if (!state.enrolled) return { kind: 'skip', reason: 'matter not enrolled in the engine' };
  if (state.manualHandling.required) return { kind: 'skip', reason: `matter is in manual handling (${state.manualHandling.reason ?? 'unspecified'})` };
  if (c.confidence < MIN_CLASSIFICATION_CONFIDENCE) return { kind: 'skip', reason: `classification confidence ${c.confidence.toFixed(2)} below ${MIN_CLASSIFICATION_CONFIDENCE}: ${c.reason}` };

  switch (c.role) {
    case 'search': {
      if (!c.searchType) return { kind: 'skip', reason: 'search result but the search type could not be determined' };
      const sr = state.searches[c.searchType];
      if (sr && sr.status !== 'ordered') return { kind: 'skip', reason: `${c.searchType} search already ${sr.status} — file manually if this is a re-issued result` };
      return { kind: 'search', searchType: c.searchType, recordOrderFirst: !sr };
    }
    case 'enquiry_reply': {
      const open = Object.values(state.enquiries).filter((q) => q.status === 'raised');
      if (open.length === 0) return { kind: 'skip', reason: 'reply received but no enquiry is awaiting one' };
      const matched = open.filter((q) => c.enquiryReferences.some((ref) => referencesMatch(ref, q.enquiryId)));
      if (matched.length === 1) return { kind: 'enquiry_reply', enquiryId: matched[0].enquiryId };
      if (matched.length === 0 && open.length === 1 && c.enquiryReferences.length === 0) return { kind: 'enquiry_reply', enquiryId: open[0].enquiryId };
      return { kind: 'skip', reason: `could not match the reply to exactly one open enquiry (references: ${c.enquiryReferences.join(', ') || 'none'}; open: ${open.map((q) => q.enquiryId).join(', ')})` };
    }
    case 'mortgage_offer':
      if (!state.hasLender) return { kind: 'skip', reason: 'mortgage offer received on a cash purchase' };
      if (state.mortgage.status === 'flagged') return { kind: 'skip', reason: 'a mortgage decision is pending' };
      return { kind: 'mortgage_offer' };
    case 'title':
      if (state.title.status === 'flagged') return { kind: 'skip', reason: 'a title decision is pending' };
      if (state.reportOnTitle.status === 'sent') return { kind: 'skip', reason: 'report on title already sent' };
      return { kind: 'title' };
    case 'id_check':
      if (state.idCheck.status !== 'requested') return { kind: 'skip', reason: `ID check is ${state.idCheck.status}, not awaiting a result` };
      return { kind: 'id_check' };
    default:
      return { kind: 'skip', reason: `document classified as ${c.role}` };
  }
}

export interface IngestReport {
  documentId: string;
  classification: DocumentClassification | null;
  action: IngestAction;
  result: RunResult | null;
}

/** Classify + route + run. Best-effort at the call site; throws only on programmer error. */
export async function ingestDocument(svc: EngineService, ports: EnginePorts, tenantId: string, matterId: string, doc: DocumentRef): Promise<IngestReport> {
  const state = await svc.getState(tenantId, matterId);
  if (!state.enrolled) return { documentId: doc.id, classification: null, action: { kind: 'skip', reason: 'matter not enrolled in the engine' }, result: null };
  if (!ports.classifier) return { documentId: doc.id, classification: null, action: { kind: 'skip', reason: 'no document classifier configured — use the /ingest route with an explicit role' }, result: null };

  let classification: DocumentClassification;
  try {
    classification = await ports.classifier.classify(doc);
  } catch (err) {
    ports.log(`classification failed for document ${doc.id}`, err);
    return { documentId: doc.id, classification: null, action: { kind: 'skip', reason: 'classification failed' }, result: null };
  }
  const action = routeClassification(state, classification);
  const result = await runAction(svc, tenantId, matterId, doc.id, action);
  return { documentId: doc.id, classification, action, result };
}

export async function runAction(svc: EngineService, tenantId: string, matterId: string, documentId: string, action: IngestAction): Promise<RunResult | null> {
  switch (action.kind) {
    case 'search':
      if (action.recordOrderFirst) {
        await svc.run(tenantId, matterId, { type: 'record_search_ordered', actor: EXTERNAL, searchType: action.searchType, provider: 'unknown (result arrived without a recorded order)' });
      }
      return svc.searchReturned(tenantId, matterId, action.searchType, documentId);
    case 'enquiry_reply':
      return svc.enquiryReplyReceived(tenantId, matterId, action.enquiryId, documentId);
    case 'mortgage_offer':
      return svc.mortgageOfferReceived(tenantId, matterId, documentId);
    case 'title':
      return svc.titleReceived(tenantId, matterId, documentId);
    case 'id_check':
      return svc.idCheckResultReceived(tenantId, matterId, documentId);
    case 'skip':
      return null;
  }
}

export { MIN_EXTRACTION_CONFIDENCE };
