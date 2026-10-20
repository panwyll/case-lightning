/**
 * Local development only: a purchase part-way through, run by the real engine in memory (mock ports, no database),
 * for the client portal preview. Made-up people and property; nothing here is a real case.
 *
 * Six weeks in: ID checked, title in, two of three searches back and the drainage search late and chased, our
 * enquiries with the seller's solicitor, the mortgage offer awaited, and the proof-of-funds form with the client.
 */
import { EngineService } from './engine/service';
import { MemoryEventStore } from './engine/store';
import { mockPorts } from './engine/mocks';
import { pendingDecisions, type LevelConfig } from './engine/types';
import * as F from './engine/scenarios/fixtures';

const T = '44444444-4444-4444-8444-444444444444';
const M = '55555555-5555-4555-8555-555555555555';
const U = '66666666-6666-4666-8666-666666666666';
const LEVELS: LevelConfig = { acknowledgement: 'auto', chase: 'auto', client_update: 'auto', search_order: 'auto', auto_clear: 'auto' };
const DAY = 86_400_000;

/** The made-up case's people and firm, as its messages and the portal name them. */
export const DEV_CASE = { firmName: 'Hartley & Rowe (Demo)', propertyAddress: '27 Clarendon Road, Leeds LS2 9NZ', clientFirstName: 'Priya', handler: { name: 'Asha Patel', email: 'asha@hartleyrowe.test', phone: '0113 496 0123' } };

type Sent = { at: string; kind: 'update' | 'chase' | 'request' | 'ack' | 'message'; template?: string; context?: Record<string, unknown>; what?: string; subject?: string; body?: string; recipientRole?: string; override?: { subject?: string | null; body?: string | null } | null };
let built: Promise<{ svc: EngineService; tenantId: string; matterId: string; sent: Sent[] }> | null = null;

export function devPurchase() {
  return (built ??= (async () => {
    const today = Date.now();
    const ports = mockPorts(new Date(today - 42 * DAY));
    ports.autoStartOnEnrol = false;
    const svc = new EngineService(new MemoryEventStore(LEVELS), ports);
    // What went to the client, and when: rendered with the real templates for History (devHistory).
    const sent: Sent[] = [];
    const when = () => ports.now().toISOString();
    const cc = ports.clientComms; const send = cc.sendStatusUpdate.bind(cc);
    cc.sendStatusUpdate = async (i) => { sent.push({ at: when(), kind: 'update', template: i.template, context: i.context, override: i.override ?? null }); return send(i); };
    const ch = ports.chaser as unknown as Record<string, (i: Record<string, unknown>) => Promise<unknown>>;
    for (const [m, kind] of [['sendChase', 'chase'], ['sendRequest', 'request'], ['sendAcknowledgement', 'ack'], ['sendMessage', 'message']] as const) {
      const orig = ch[m].bind(ch);
      ch[m] = async (i) => { if (i.recipientRole === 'client') sent.push({ at: when(), kind, ...(i as object) }); return orig(i); };
    }
    const at = (daysAgo: number) => ports.setNow(new Date(today - daysAgo * DAY));
    const run = (cmd: Record<string, unknown>) => svc.run(T, M, { actor: U, ...cmd } as never);
    const doc = (facts: unknown) => ports.documents.seed({ tenantId: T, matterId: M, docType: 'PDF', extractedFacts: facts }).id;
    // Whatever the engine asks a person, the person approves (as a conveyancer would on a clean file).
    const settle = async () => {
      for (let i = 0; i < 10; i++) {
        const d = pendingDecisions(await svc.getState(T, M))[0];
        if (!d) return;
        await svc.openDecisionSource(T, M, d.eventId, U);
        await svc.resolveDecision(T, M, d.eventId, U, (d.options.includes('approve' as never) ? 'approve' : d.options[0]) as never, 'Checked');
      }
    };
    const iso = (days: number) => new Date(today + days * DAY).toISOString().slice(0, 10);

    at(42);
    await run({ type: 'enrol', transactionType: 'freehold_purchase', hasLender: true, requiredSearches: ['LLC1', 'CON29', 'DRAINAGE_WATER'], requireProofOfFunds: true, targetExchangeDate: iso(24), targetCompletionDate: iso(38) });
    await svc.requestIdCheck(T, M, U);
    at(40); await svc.idCheckResultReceived(T, M, doc(F.idClear())); await settle();
    at(39); await run({ type: 'record_sdlt_facts', mainResidence: true, anyEverOwned: false });
    at(36); await svc.titleReceived(T, M, doc(F.titleClear())); await settle();
    await svc.contractReceived(T, M, doc(F.contract())); await settle();
    at(16); await svc.searchReturned(T, M, 'LLC1', doc(F.searchClear('LLC1'))); await settle();
    at(13); await svc.searchReturned(T, M, 'CON29', doc(F.searchClear('CON29'))); await settle();
    at(9);
    for (const [enquiryId, subject] of [['E1', 'the boundary fence on the left'], ['E2', 'the guarantee for the 2021 roof']]) await run({ type: 'raise_enquiry', enquiryId, subject });
    at(7); await svc.surveyReceived(T, M, doc({ surveyType: 'homebuyer', condition: 'fair', defects: [], recommendations: [], confidence: 0.9 })); await settle();
    at(5); await svc.requestProofOfFunds(T, M, U);
    // The daily check, as it would have run: chases go when their timers say.
    for (let d = 40; d >= 0; d--) { at(d); await svc.tick(T, M).catch(() => null); }
    ports.setNow(new Date(today));
    return { svc, tenantId: T, matterId: M, sent };
  })());
}

/** Every message the made-up case sent its client, newest first, as the client read it (the real templates). */
export async function devHistory(): Promise<Array<{ id: string; subject: string; body: string; at: string }>> {
  const { sent } = await devPurchase();
  const { ProductionClientComms, ProductionChaser } = await import('./comms/client-comms');
  const info = { matterRef: 'DEMO-101', propertyAddress: DEV_CASE.propertyAddress, firmName: DEV_CASE.firmName, feeEarnerName: DEV_CASE.handler.name, feeEarnerUserId: null, clientFirstName: DEV_CASE.clientFirstName, clientEmail: 'priya@demo.test', clientEmails: ['priya@demo.test'], transaction: 'purchase' as const, clientPhone: null, clientWhatsAppOptIn: false, contacts: { seller_solicitor: { email: 'conveyancing@demo-sellers.test', name: 'Mason Clarke Solicitors' }, lender: { email: 'offers@demo-lender.test', name: 'Demo Building Society' } }, completionDate: null, footer: '' };
  const deps = { contactInfo: async () => info, whatsapp: null, email: null, mailbox: null, log: async () => {}, routeToHuman: async () => {}, matterForAddress: async () => null, tenantForAddress: async () => null, chaseMode: 'send' } as never;
  const comms = new ProductionClientComms(deps);
  const chaser = new ProductionChaser(deps);
  const out: Array<{ id: string; subject: string; body: string; at: string }> = [];
  for (const [i, x] of sent.entries()) {
    const m = await (x.kind === 'update' ? (x.override?.body ? Promise.resolve({ subject: x.override.subject ?? '', body: x.override.body }) : comms.previewStatusUpdate({ tenantId: T, matterId: M, template: x.template!, context: x.context ?? {} }))
      : x.kind === 'chase' ? chaser.previewChase({ tenantId: T, matterId: M, recipientRole: 'client', template: x.template!, context: x.context ?? {} })
      : x.kind === 'ack' ? chaser.previewAcknowledgement({ tenantId: T, matterId: M, recipientRole: 'client', what: x.what ?? '' })
      : x.kind === 'message' ? Promise.resolve({ subject: x.subject ?? '', body: x.body ?? '' })
      : Promise.resolve(null)).catch(() => null);
    if (m?.body) out.push({ id: `dev-msg-${i}`, subject: m.subject || 'Message from us', body: m.body, at: x.at });
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}
