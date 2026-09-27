/**
 * Sandbox matters: the scenario library's cases. A sandbox matter is a real matter row on
 * the firm's own tenant, driven by a script through the real engine, so a person can walk
 * every path of the flowchart on the real screens. It is quarantined at the port layer:
 * every outward effect the engine can have is swapped for its mock on a sandbox matter —
 * Claude never reads a sandbox document (fixture facts stand in), nothing is ordered from
 * InfoTrack, no email or chase leaves the building, no conclusion reaches LEAP or InTouch,
 * the case is never counted for billing, and email matching never lands on it. It is
 * retired in one click (the log is append-only, so nothing is deleted; it simply leaves every list).
 *
 * The guard is per call, keyed on the matterId every port input carries, so one engine
 * serves real and sandbox matters alike and nothing depends on remembering to use a
 * different service.
 */
import { query, queryOne } from '../db';
import type { EnginePorts } from './ports';
import { FixtureExtractor, MockChaser, MockClientComms, MockIdCheckProvider, MockSearchProvider, TemplateReportDrafter, TemplateSummariser } from './mocks';
import { DeterministicNoteReader } from './notes';

const SANDBOX_TTL_MS = 30_000;
const cache = new Map<string, { at: number; sandbox: boolean }>();

/** Whether a matter is a sandbox one; cached briefly (a matter never leaves the sandbox once created). */
export async function isSandboxMatter(tenantId: string, matterId: string): Promise<boolean> {
  const key = `${tenantId}:${matterId}`;
  const hit = cache.get(key);
  if (hit && (hit.sandbox || Date.now() - hit.at < SANDBOX_TTL_MS)) return hit.sandbox;
  const row = await queryOne<{ sandbox: boolean }>(`select sandbox from matter where id = $1 and tenant_id = $2`, [matterId, tenantId]).catch(() => null);
  const sandbox = !!row?.sandbox;
  cache.set(key, { at: Date.now(), sandbox });
  return sandbox;
}
export const rememberSandbox = (tenantId: string, matterId: string) => cache.set(`${tenantId}:${matterId}`, { at: Date.now(), sandbox: true });

/** The production ports, with every outward effect routed to its mock on a sandbox matter. */
export function sandboxGuard(base: EnginePorts): EnginePorts {
  const fixture = new FixtureExtractor();
  const summariser = new TemplateSummariser();
  const drafter = new TemplateReportDrafter();
  const search = new MockSearchProvider();
  const idCheck = new MockIdCheckProvider();
  const comms = new MockClientComms();
  const chaser = new MockChaser();
  const notes = new DeterministicNoteReader();
  const pick = async <T>(tenantId: string, matterId: string, real: T, mock: T): Promise<T> => ((await isSandboxMatter(tenantId, matterId)) ? mock : real);
  return {
    ...base,
    extractor: {
      name: base.extractor.name,
      extractSearch: async (doc, t) => (await pick(doc.tenantId, doc.matterId, base.extractor, fixture)).extractSearch(doc, t),
      extractEnquiryReply: async (doc, id) => (await pick(doc.tenantId, doc.matterId, base.extractor, fixture)).extractEnquiryReply(doc, id),
      extractMortgageOffer: async (doc) => (await pick(doc.tenantId, doc.matterId, base.extractor, fixture)).extractMortgageOffer(doc),
      extractTitle: async (doc) => (await pick(doc.tenantId, doc.matterId, base.extractor, fixture)).extractTitle(doc),
      extractIdCheck: async (doc) => (await pick(doc.tenantId, doc.matterId, base.extractor, fixture)).extractIdCheck(doc),
      extractContract: async (doc) => (await pick(doc.tenantId, doc.matterId, base.extractor, fixture)).extractContract(doc),
      extractLease: async (doc) => (await pick(doc.tenantId, doc.matterId, base.extractor, fixture)).extractLease(doc),
      extractManagementPack: async (doc) => (await pick(doc.tenantId, doc.matterId, base.extractor, fixture)).extractManagementPack(doc),
      extractStatement: async (doc) => (await pick(doc.tenantId, doc.matterId, base.extractor, fixture)).extractStatement(doc),
      extractSurvey: async (doc) => (await pick(doc.tenantId, doc.matterId, base.extractor, fixture)).extractSurvey(doc),
    },
    classifier: base.classifier ? { name: base.classifier.name, classify: async (doc) => ((await isSandboxMatter(doc.tenantId, doc.matterId)) ? { role: 'other', searchType: null, enquiryReferences: [], titleNumber: null, lender: null, confidence: 0, reason: 'sandbox: file with an explicit role' } : base.classifier!.classify(doc)) } : base.classifier,
    summariser: { name: base.summariser.name, summarise: async (input) => (await pick(input.state.tenantId, input.state.matterId, base.summariser, summariser)).summarise(input) },
    reportDrafter: { name: base.reportDrafter.name, draft: async (input) => (await pick(input.state.tenantId, input.state.matterId, base.reportDrafter, drafter)).draft(input) },
    pofSummariser: base.pofSummariser ? { name: base.pofSummariser.name, summarise: async (input) => ((await isSandboxMatter(input.state.tenantId, input.state.matterId)) ? null : base.pofSummariser!.summarise(input)) } : base.pofSummariser,
    noteExtractor: base.noteExtractor ? { name: base.noteExtractor.name, extract: async (input) => (await pick(input.tenantId, input.matterId, base.noteExtractor!, notes)).extract(input) } : base.noteExtractor,
    searchProvider: { name: base.searchProvider.name, orderSearch: async (input) => (await pick(input.tenantId, input.matterId, base.searchProvider, search)).orderSearch(input) },
    idCheckProvider: { name: base.idCheckProvider.name, requestCheck: async (input) => (await pick(input.tenantId, input.matterId, base.idCheckProvider, idCheck)).requestCheck(input) },
    clientComms: {
      name: base.clientComms.name,
      sendStatusUpdate: async (input) => (await pick(input.tenantId, input.matterId, base.clientComms, comms)).sendStatusUpdate(input),
      sendReportOnTitle: async (input) => (await pick(input.tenantId, input.matterId, base.clientComms, comms)).sendReportOnTitle(input),
    },
    chaser: {
      name: base.chaser.name,
      sendChase: async (input) => (await pick(input.tenantId, input.matterId, base.chaser, chaser)).sendChase(input),
      sendPartyNotice: async (input) => (await pick(input.tenantId, input.matterId, base.chaser, chaser)).sendPartyNotice(input),
      sendAcknowledgement: async (input) => (await pick(input.tenantId, input.matterId, base.chaser, chaser)).sendAcknowledgement(input),
    },
    onEvents: base.onEvents ? async (input) => { if (!(await isSandboxMatter(input.tenantId, input.matterId))) await base.onEvents!(input); } : undefined,
  };
}

/**
 * Retire a sandbox matter. The event log is append-only by trigger (the audit rule) and
 * documents are cited by events, so a sandbox is never deleted: it is closed off — status
 * MERGED (the board and the caseload never show one), its engine state finished so the
 * timers skip it, its tasks removed — and it drops out of the library's list. Refuses
 * anything that is not a sandbox.
 */
export async function retireSandboxMatter(tenantId: string, matterId: string): Promise<{ retired: boolean }> {
  const row = await queryOne<{ sandbox: boolean }>(`select sandbox from matter where id = $1 and tenant_id = $2`, [matterId, tenantId]);
  if (!row?.sandbox) return { retired: false };
  await query(`update matter set status = 'MERGED', sandbox_step = coalesce(sandbox_step, '') || ' · retired', updated_at = now() where id = $1 and tenant_id = $2 and sandbox`, [matterId, tenantId]);
  await query(`update matter_engine_state set finished_at = coalesce(finished_at, now()) where matter_id = $1 and tenant_id = $2`, [matterId, tenantId]).catch(() => {});
  await query(`delete from matter_task where matter_id = $1 and tenant_id = $2`, [matterId, tenantId]).catch(() => {});
  cache.delete(`${tenantId}:${matterId}`);
  return { retired: true };
}

export interface SandboxMatterRow { id: string; matterRef: string; propertyAddress: string; scenario: string | null; step: string | null; createdAt: string; stage: string | null }
export async function listSandboxMatters(tenantId: string): Promise<SandboxMatterRow[]> {
  return query<SandboxMatterRow>(
    `select m.id, m.matter_ref as "matterRef", m.property_address as "propertyAddress", m.sandbox_scenario as scenario, m.sandbox_step as step, m.created_at as "createdAt", s.stage
       from matter m left join matter_engine_state s on s.matter_id = m.id and s.tenant_id = m.tenant_id
      where m.tenant_id = $1 and m.sandbox and coalesce(m.status, 'OPEN') <> 'MERGED' order by m.created_at desc`,
    [tenantId]
  );
}
