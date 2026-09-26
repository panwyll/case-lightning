/**
 * Shared fixtures for the engine tests: a mock-port service over the in-memory store,
 * plus typed fact builders shaped like what extraction pipeline #2 will produce.
 */
import { EngineService } from '../../../lib/server/engine/service';
import { MemoryEventStore } from '../../../lib/server/engine/store';
import { mockPorts, type MockPorts } from '../../../lib/server/engine/mocks';
import { blockingDecisions, type LevelConfig, type MatterState, type DecisionKind, type DecisionState } from '../../../lib/server/engine/types';
import type { EnquiryReplyFacts, IdCheckFacts, MortgageOfferFacts, SearchFacts, SearchType, TitleFacts } from '../../../lib/server/engine/types';

/** Sends and orders unasked; auto-clears confirmed afterwards (the fullest exercise of the machine). */
export const FIXTURE_LEVELS: LevelConfig = { acknowledgement: 'auto', chase: 'auto', client_update: 'auto', search_order: 'auto', auto_clear: 'assist' };

export const TENANT = '11111111-1111-4111-8111-111111111111';
export const MATTER = '22222222-2222-4222-8222-222222222222';
export const USER = '33333333-3333-4333-8333-333333333333';
export const SENIOR = '44444444-4444-4444-8444-444444444444';

export interface Harness {
  svc: EngineService;
  store: MemoryEventStore;
  ports: MockPorts;
  /** Register a document carrying pre-extracted facts and return its id. */
  doc: (facts: unknown, docType?: string) => string;
  /** Advance the injected clock by N calendar days. */
  advanceDays: (n: number) => Date;
}

export function harness(start = new Date('2026-09-14T09:00:00Z')): Harness {
  // The product default is PROPOSE for every action; these fixtures run the machine with
  // everything unasked except the auto-clear confirmation, so every path is exercised
  // end to end. levels.test.ts covers the gate itself.
  const store = new MemoryEventStore(FIXTURE_LEVELS);
  const ports = mockPorts(start);
  const svc = new EngineService(store, ports);
  return {
    svc,
    store,
    ports,
    doc: (facts, docType = 'PDF') => ports.documents.seed({ tenantId: TENANT, matterId: MATTER, docType, extractedFacts: facts }).id,
    advanceDays: (n) => {
      const d = new Date(ports.now().getTime() + n * 86_400_000);
      ports.setNow(d);
      return d;
    },
  };
}

export const idClear = (): IdCheckFacts => ({ provider: 'mock-id', outcome: 'clear', flags: [], confidence: 0.99 });
export const idRefer = (): IdCheckFacts => ({ provider: 'mock-id', outcome: 'refer', flags: [{ code: 'PEP_MATCH', severity: 'medium', description: 'Possible PEP match', locator: { page: 2 } }], confidence: 0.97 });

export const searchClear = (searchType: SearchType): SearchFacts => ({ searchType, flags: [{ code: 'CON29_NOTE', severity: 'info', description: 'Road adopted', locator: { page: 3 } }], confidence: 0.96 });
export const searchFlagged = (searchType: SearchType): SearchFacts => ({
  searchType,
  flags: [{ code: 'PLANNING_ENFORCEMENT', severity: 'high', description: 'Enforcement notice registered 2024 re: rear extension', locator: { page: 4, section: '3.7' } }],
  confidence: 0.93,
});
export const searchLowConfidence = (searchType: SearchType): SearchFacts => ({ searchType, flags: [], confidence: 0.4 });

export const replyClear = (enquiryId: string): EnquiryReplyFacts => ({ enquiryId, status: 'answered', issues: [], confidence: 0.95 });
export const replyPartial = (enquiryId: string): EnquiryReplyFacts => ({ enquiryId, status: 'partial', issues: [], confidence: 0.95 });

export const offerClear = (): MortgageOfferFacts => ({
  lender: 'Mock Building Society',
  amountPennies: 25_000_000,
  expiryDate: '2027-03-01',
  conditions: [{ code: 'STD1', text: 'Buildings insurance in place on completion', standard: true }],
  confidence: 0.97,
});
export const offerSpecial = (): MortgageOfferFacts => ({
  ...offerClear(),
  conditions: [...offerClear().conditions, { code: 'SC4', text: 'Retention of £5,000 pending roof repairs', standard: false, locator: { page: 6, section: 'Special conditions' } }],
});

export const titleClear = (): TitleFacts => ({ titleNumber: 'AB123456', tenure: 'freehold', restrictions: [], charges: [], covenants: [], confidence: 0.98 });
export const titleWithCharge = (): TitleFacts => ({ ...titleClear(), charges: [{ code: 'C1', text: 'Registered charge dated 12 May 2019 in favour of Big Bank plc', register: 'C', locator: { page: 2, section: 'C: Charges register' } }] });
export const titleLeasehold = (): TitleFacts => ({ ...titleClear(), tenure: 'leasehold' });

/** Resolve a decision the honest way: open the source first, then choose. */
export async function resolve(h: Harness, decisionEventId: string, option: 'approve' | 'refer_to_client' | 'request_further' | 'escalate' | 'reject' | 'indemnity', userId = USER, note?: string) {
  await h.svc.openDecisionSource(TENANT, MATTER, decisionEventId, userId);
  return h.svc.resolveDecision(TENANT, MATTER, decisionEventId, userId, option, note);
}

/** The first pending decision that gates progress (assist-level auto-clear reviews excluded), optionally of one kind. */
export function firstDecision(state: MatterState, kind?: DecisionKind): DecisionState {
  const d = blockingDecisions(state).find((x) => !kind || x.kind === kind);
  if (!d) throw new Error(`no pending ${kind ?? 'blocking'} decision`);
  return d;
}
