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
import { query, queryOne, runOutsideAutomation } from '../db';
import { putBlob } from '../blob-store';
import type { ClientComms, EnginePorts, ThirdPartyChaser } from './ports';
import crypto from 'node:crypto';
import { FixtureExtractor, MockIdCheckProvider, MockSearchProvider, MockSigning, TemplateReportDrafter, TemplateSummariser } from './mocks';
import { ProductionChaser, ProductionClientComms, type CommsDeps, type MatterContactInfo } from '../comms/client-comms';
import { contactInfo, productionCommsDeps } from '../comms/adapters';
import { DeterministicNoteReader } from './notes';

const SANDBOX_TTL_MS = 30_000;
const cache = new Map<string, { at: number; sandbox: boolean }>();

/** Whether a matter is a sandbox one; cached briefly (a matter never leaves the sandbox once created). */
export async function isSandboxMatter(tenantId: string, matterId: string): Promise<boolean> {
  const key = `${tenantId}:${matterId}`;
  const hit = cache.get(key);
  if (hit && (hit.sandbox || Date.now() - hit.at < SANDBOX_TTL_MS)) return hit.sandbox;
  // Read on the app role: the engine's effects run as the automation role, and a row it cannot see must never be taken for "not a sandbox" — that would route a
  // sandbox's mail to the real senders. An unanswerable lookup throws, so the send fails loudly instead of going the wrong way.
  const row = await runOutsideAutomation(() => queryOne<{ sandbox: boolean }>(`select sandbox from matter where id = $1 and tenant_id = $2`, [matterId, tenantId]));
  if (!row) throw new Error('Could not tell whether this case is a sandbox; nothing was sent.');
  const sandbox = !!row.sandbox;
  cache.set(key, { at: Date.now(), sandbox });
  return sandbox;
}
export const rememberSandbox = (tenantId: string, matterId: string) => cache.set(`${tenantId}:${matterId}`, { at: Date.now(), sandbox: true });

/** The production ports, with every outward effect routed to its mock on a sandbox matter. */
/** A port whose every method goes to `mock` on a sandbox matter and to `real` otherwise (methods take `{ tenantId, matterId }`). */
export function routeEach<T extends object>(real: T, mock: T, pick: <X>(tenantId: string, matterId: string, real: X, mock: X) => Promise<X>): T {
  const out: Record<string, unknown> = {};
  const keys = new Set<string>();
  for (let o: object | null = real; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) for (const k of Object.getOwnPropertyNames(o)) keys.add(k);
  for (const k of keys) {
    if (k === 'constructor') continue;
    const v = (real as Record<string, unknown>)[k];
    if (typeof v !== 'function') { out[k] = v; continue; }
    out[k] = async (input: { tenantId: string; matterId: string }, ...rest: unknown[]) => {
      const target = (await pick(input.tenantId, input.matterId, real, mock)) as Record<string, (...a: unknown[]) => unknown>;
      // A sandbox never falls through to the live sender: a method its outbox lacks refuses.
      if (typeof target[k] !== 'function') throw new Error(`${k} is not available on a sandbox case.`);
      return target[k].call(target, input, ...rest);
    };
  }
  return out as T;
}

export function sandboxGuard(base: EnginePorts): EnginePorts {
  const fixture = new FixtureExtractor();
  const summariser = new TemplateSummariser();
  const drafter = new TemplateReportDrafter();
  const sandboxSigning = new MockSigning();
  const search = new MockSearchProvider();
  const idCheck = new MockIdCheckProvider();
  // The outbox: the live senders, rendering the firm's own wording with the case's data, delivering into the case's documents instead of a mailbox.
  const outboxDeps = sandboxCommsDeps();
  const comms = new ProductionClientComms(outboxDeps);
  const chaser = new ProductionChaser(outboxDeps);
  const notes = new DeterministicNoteReader();
  const pick = async <T>(tenantId: string, matterId: string, real: T, mock: T): Promise<T> => ((await isSandboxMatter(tenantId, matterId)) ? mock : real);
  // Reading is not an outward effect: a scenario's own file (it carries its facts) is read by the fixture, but a real file a
  // person uploads to a sandbox is read for real — otherwise it is never read and the step it answers never moves.
  const pickDoc = async <T>(doc: { tenantId: string; matterId: string; extractedFacts: unknown }, real: T, mock: T): Promise<T> => (doc.extractedFacts != null && (await isSandboxMatter(doc.tenantId, doc.matterId)) ? mock : real);
  return {
    ...base,
    extractor: {
      name: base.extractor.name,
      extractSearch: async (doc, t) => (await pickDoc(doc, base.extractor, fixture)).extractSearch(doc, t),
      extractEnquiryReply: async (doc, id) => (await pickDoc(doc, base.extractor, fixture)).extractEnquiryReply(doc, id),
      extractMortgageOffer: async (doc) => (await pickDoc(doc, base.extractor, fixture)).extractMortgageOffer(doc),
      extractTitle: async (doc) => (await pickDoc(doc, base.extractor, fixture)).extractTitle(doc),
      extractSupportingDocument: async (doc) => { const x = await pickDoc(doc, base.extractor, fixture); if (!x.extractSupportingDocument) throw new Error('No supporting-document reader here.'); return x.extractSupportingDocument(doc); },
      extractTitlePlan: async (doc) => { const x = await pickDoc(doc, base.extractor, fixture); if (!x.extractTitlePlan) throw new Error('No title plan reader here.'); return x.extractTitlePlan(doc); },
      extractIdCheck: async (doc) => (await pickDoc(doc, base.extractor, fixture)).extractIdCheck(doc),
      extractContract: async (doc) => (await pickDoc(doc, base.extractor, fixture)).extractContract(doc),
      extractLease: async (doc) => (await pickDoc(doc, base.extractor, fixture)).extractLease(doc),
      extractManagementPack: async (doc) => (await pickDoc(doc, base.extractor, fixture)).extractManagementPack(doc),
      extractStatement: async (doc) => (await pickDoc(doc, base.extractor, fixture)).extractStatement(doc),
      extractEvidence: async (doc) => { const ex = await pickDoc(doc, base.extractor, fixture); if (ex.extractEvidence) return ex.extractEvidence(doc); const st = await ex.extractStatement(doc); return { kind: st ? 'bank_statement' : 'other', statement: st, payslip: null }; },
      extractSurvey: async (doc) => (await pickDoc(doc, base.extractor, fixture)).extractSurvey(doc),
      extractPropertyForms: async (doc) => (await pickDoc(doc, base.extractor, fixture)).extractPropertyForms(doc),
    },
    classifier: base.classifier ? { name: base.classifier.name, classify: async (doc) => (doc.extractedFacts != null && (await isSandboxMatter(doc.tenantId, doc.matterId)) ? { role: 'other', searchType: null, enquiryReferences: [], titleNumber: null, lender: null, confidence: 0, reason: 'sandbox: file with an explicit role' } : base.classifier!.classify(doc)) } : base.classifier,
    summariser: { name: base.summariser.name, summarise: async (input) => (await pick(input.state.tenantId, input.state.matterId, base.summariser, summariser)).summarise(input) },
    reportDrafter: { name: base.reportDrafter.name, draft: async (input) => (await pick(input.state.tenantId, input.state.matterId, base.reportDrafter, drafter)).draft(input) },
    pofSummariser: base.pofSummariser ? { name: base.pofSummariser.name, summarise: async (input) => ((await isSandboxMatter(input.state.tenantId, input.state.matterId)) ? null : base.pofSummariser!.summarise(input)) } : base.pofSummariser,
    noteExtractor: base.noteExtractor ? { name: base.noteExtractor.name, extract: async (input) => (await pick(input.tenantId, input.matterId, base.noteExtractor!, notes)).extract(input) } : base.noteExtractor,
    // Optional members are carried over too: a dropped placeholderResult once left every live case's searches waiting on a stand-in that never answers.
    searchProvider: {
      name: base.searchProvider.name,
      orderSearch: async (input) => (await pick(input.tenantId, input.matterId, base.searchProvider, search)).orderSearch(input),
      ...(base.searchProvider.placeholderResult ? { placeholderResult: (input) => base.searchProvider.placeholderResult!(input) } : {}),
    },
    idCheckProvider: {
      name: base.idCheckProvider.name,
      sendsClientLink: base.idCheckProvider.sendsClientLink,
      requestCheck: async (input) => (await pick(input.tenantId, input.matterId, base.idCheckProvider, idCheck)).requestCheck(input),
      ...(base.idCheckProvider.forFirm ? { forFirm: (tenantId: string) => base.idCheckProvider.forFirm!(tenantId) } : {}),
    },
    // Every sender the live port has, sent to the case's outbox instead on a sandbox: listed from the port itself,
    // so a method added later (a first request, our enquiries) is never dropped — a dropped optional method reads as "not configured" on every case.
    clientComms: routeEach(base.clientComms, comms as unknown as ClientComms, pick),
    chaser: routeEach(base.chaser, chaser as unknown as ThirdPartyChaser, pick),
    // The signing pack is an outward send too: a sandbox's goes to the mock, never a real mailbox or provider.
    signing: base.signing ? { name: base.signing.name, defaults: (t, l) => base.signing!.defaults(t, l), sendPack: async (input) => ((await isSandboxMatter(input.tenantId, input.matterId)) ? sandboxSigning : base.signing!).sendPack(input) } : base.signing,
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

const STAND_IN = {
  client: 'sandbox.client@example.invalid',
  seller_solicitor: { email: 'sandbox.other-side@example.invalid', name: 'Sandbox Solicitors LLP' },
  lender: { email: 'sandbox.lender@example.invalid', name: 'Mock Building Society' },
  estate_agent: { email: 'sandbox.agent@example.invalid', name: 'Sandbox Estate Agents' },
};

/** The HTML the live sender builds is plain text with line breaks; take it back to text for the file. */
const htmlToText = (html: string): string => html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();

/**
 * The sandbox outbox as comms dependencies: the real contact lookup with stand-in addresses
 * where a sandbox case has none, the firm's own template wording, and every send filed on
 * the case as a SANDBOX_EMAIL document instead of leaving through a mailbox. Nothing here is
 * reachable from a real case: the guard hands these deps to the senders only when the
 * matter is a sandbox, and a real case with no mailbox configured still fails as before.
 */
export function sandboxCommsDeps(): CommsDeps {
  const real = productionCommsDeps();
  const file = async (tenantId: string, matterId: string, input: { to: string; subject: string; text: string; status: 'SENT' | 'DRAFTED'; fromUserId?: string | null }): Promise<{ messageId: string | null }> => {
    const when = new Date().toISOString();
    const body = [`SANDBOX OUTBOX — rendered, not sent`, `To: ${input.to}`, `Subject: ${input.subject}`, `Status: ${input.status === 'SENT' ? 'would have been sent' : 'would have been drafted for the fee earner'}`, `At: ${when}`, '', input.text].join('\n');
    const bytes = Buffer.from(body, 'utf8');
    const d = await queryOne<{ id: string }>(
      `insert into document (tenant_id, matter_id, source_type, storage_path, file_name, mime_type, size_bytes, hash_sha256, doc_type, extracted_facts, extraction_confidence, created_by)
       values ($1, $2, 'SANDBOX', $3, $4, 'text/plain', $5, $6, 'SANDBOX_EMAIL', $7::jsonb, 1, $8) returning id`,
      [tenantId, matterId, `sandbox://${matterId}/outbox/${when}`, `Email - ${input.subject.replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 80)} - ${when.slice(0, 16).replace('T', ' ').replace(':', '.')}.txt`, bytes.length, crypto.createHash('sha256').update(bytes).digest('hex'), JSON.stringify({ content: body, to: input.to, subject: input.subject, status: input.status, at: when, template: null }), input.fromUserId ?? null]
    ).catch(() => null);
    if (d) await putBlob(tenantId, d.id, bytes).catch(() => {});
    return { messageId: d?.id ?? null };
  };
  // The senders only hand the tenant and matter to contactInfo and log; the file needs both, so they ride along per call.
  let current: { tenantId: string; matterId: string } | null = null;
  return {
    contactInfo: async (tenantId, matterId) => {
      current = { tenantId, matterId };
      const info: MatterContactInfo = await contactInfo(tenantId, matterId);
      return {
        ...info,
        clientEmail: info.clientEmail ?? STAND_IN.client,
        clientEmails: info.clientEmails?.length ? info.clientEmails : [info.clientEmail ?? STAND_IN.client],
        clientWhatsAppOptIn: false,
        contacts: { seller_solicitor: info.contacts.seller_solicitor ?? STAND_IN.seller_solicitor, lender: info.contacts.lender ?? STAND_IN.lender, estate_agent: info.contacts.estate_agent ?? STAND_IN.estate_agent },
      };
    },
    whatsapp: null,
    email: { send: async ({ to, subject, text, fromUserId }) => file(current!.tenantId, current!.matterId, { to: [to].flat().join(', '), subject, text, status: 'SENT', fromUserId }) },
    mailbox: {
      send: async (userId, to, subject, bodyHtml) => file(current!.tenantId, current!.matterId, { to: [to].flat().join(', '), subject, text: htmlToText(bodyHtml), status: 'SENT', fromUserId: userId }),
      draft: async (userId, to, subject, bodyHtml) => file(current!.tenantId, current!.matterId, { to: [to].flat().join(', '), subject, text: htmlToText(bodyHtml), status: 'DRAFTED', fromUserId: userId }),
    },
    // The template name arrives with the log line; it goes onto the filed email. Nothing is written to the client-message history.
    log: async (i) => {
      if (i.providerRef && i.template) await query(`update document set extracted_facts = extracted_facts || $3::jsonb, file_name = $4 where id = $1 and tenant_id = $2 and doc_type = 'SANDBOX_EMAIL'`, [i.providerRef, i.tenantId, JSON.stringify({ template: i.template }), `Email - ${(i.subject ?? i.template).replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 80)} - ${new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '.')}.txt`]).catch(() => {});
    },
    routeToHuman: async () => {},
    matterForAddress: async () => null,
    tenantForAddress: async () => null,
    chaseMode: 'send',
    ackMode: 'send',
    templateOverride: real.templateOverride,
    briefFor: real.briefFor,
    onChaseDrafted: async () => {},
  };
}
