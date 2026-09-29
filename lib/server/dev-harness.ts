/**
 * Local development only: one in-memory case run by the real engine (mock ports, no database),
 * so the Tasks list and the case's task panels can be seen and clicked without signing in.
 * The /dev/harness page routes its /api/v1 calls here; both refuse to exist in production.
 */
import { EngineService } from './engine/service';
import { MemoryEventStore } from './engine/store';
import { mockPorts } from './engine/mocks';
import { dueSteps } from './engine/due';
import { matterWork, buckets } from './engine/work';
import { pendingDecisions, surfacedDecisions, type LevelConfig } from './engine/types';
import { profileOf } from './engine/transactions';

export const DEV_TENANT = '11111111-1111-4111-8111-111111111111';
export const DEV_MATTER = '22222222-2222-4222-8222-222222222222';
export const DEV_USER = '33333333-3333-4333-8333-333333333333';
const LEVELS: LevelConfig = { acknowledgement: 'propose', chase: 'propose', client_update: 'propose', search_order: 'propose', auto_clear: 'assist' };

let h: { svc: EngineService; ports: ReturnType<typeof mockPorts>; names: Map<string, string> } | null = null;

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

/** A freehold sale awaiting official copies, with the issues a real file carries. */
export async function devHarness() {
  if (h) return h;
  const store = new MemoryEventStore(LEVELS);
  const ports = mockPorts(new Date());
  ports.autoStartOnEnrol = false;
  const svc = new EngineService(store, ports);
  h = { svc, ports, names: new Map() };
  const run = (cmd: Record<string, unknown>) => svc.run(DEV_TENANT, DEV_MATTER, { actor: DEV_USER, ...cmd } as never);
  await run({ type: 'enrol', transactionType: 'freehold_sale', hasLender: false, hasExistingMortgage: false, requiredSearches: [] });
  await run({ type: 'raise_issue', kind: 'building_regs_missing', title: 'No building regs sign-off for the 2019 loft conversion', detail: 'TA6 section 4 says the loft was converted in 2019; no completion certificate supplied.', resolveBy: day(-2) });
  await run({ type: 'raise_issue', kind: 'restrictive_covenant', title: 'Covenant against alterations without the developer\'s consent', resolveBy: day(4) });
  await run({ type: 'raise_issue', kind: 'probate_issue', title: 'Grant of probate not yet issued for the late Mr Jones', resolveBy: day(0) });
  await run({ type: 'raise_issue', kind: 'seller_delay', title: 'Seller away until the 14th' });
  return h;
}

export async function devView() {
  const { svc } = await devHarness();
  const state = await svc.getState(DEV_TENANT, DEV_MATTER);
  const profile = profileOf(state.transactionType);
  return {
    state,
    profile: { ...profile, lifecycle: [], gates: [] },
    blockers: [],
    waits: [],
    pendingDecisions: pendingDecisions(state),
    surfacedDecisions: surfacedDecisions(state),
    due: dueSteps(state, new Date()),
    documentCount: 0,
    people: {},
    levels: LEVELS,
    contracts: {},
    matter: { matterRef: 'DEV-001', propertyAddress: '14 Oak Street, Leeds LS1 2AB', shadowMode: false, sandbox: false },
  };
}

export async function devWork() {
  const { svc } = await devHarness();
  const state = await svc.getState(DEV_TENANT, DEV_MATTER);
  const items = matterWork(state, new Date(), { matterRef: 'DEV-001', propertyAddress: '14 Oak Street, Leeds LS1 2AB', assignedTo: DEV_USER }).items.map((i) => ({ ...i, caseBand: 'blocked' as const }));
  return { ...buckets(items), viewerRole: 'ADMIN', scope: 'all', matters: 1 };
}

export async function devDocuments() {
  const { ports, names } = await devHarness();
  const docs = (ports.documents as unknown as { docs?: Map<string, { id: string; fileName: string | null; docType: string | null }> }).docs;
  const list = docs ? [...docs.values()] : [];
  return { documents: list.map((d) => ({ id: d.id, fileName: names.get(d.id) ?? d.fileName, docType: d.docType, webUrl: null, createdAt: new Date().toISOString() })) };
}

/** An upload: "register" / "official copies" in the name reads as the register; anything else reads as a transfer deed. */
export async function devUpload(fileName: string, role: string) {
  const { svc, ports, names } = await devHarness();
  const isRegister = /register|official/i.test(fileName);
  const doc = ports.documents.seed({ tenantId: DEV_TENANT, matterId: DEV_MATTER, docType: 'PDF', fileName, extractedFacts: isRegister ? { titleNumber: 'WYK123456', tenure: 'freehold', restrictions: [], charges: [], covenants: [], confidence: 0.98 } : null });
  names.set(doc.id, fileName);
  if (role === 'evidence') return { documentId: doc.id, action: { kind: 'skip', reason: 'filed as evidence' }, classification: null };
  if (isRegister) {
    await svc.titleReceived(DEV_TENANT, DEV_MATTER, doc.id);
    return { documentId: doc.id, action: { kind: 'title' }, classification: { role: 'title' } };
  }
  return { documentId: doc.id, action: { kind: 'skip', reason: 'not a register' }, classification: { role: 'contract' } };
}

export async function devRun(body: Record<string, unknown>) {
  const { svc } = await devHarness();
  // The commands the real route runs through the service rather than the machine.
  const r = body.type === 'retry_action' ? await svc.retryFailedAction(DEV_TENANT, DEV_MATTER, String(body.proposalEventId), DEV_USER)
    : body.type === 'request_proof_of_funds' ? await svc.requestProofOfFunds(DEV_TENANT, DEV_MATTER, DEV_USER)
    : body.type === 'draft_report_on_title' ? await svc.draftReportOnTitle(DEV_TENANT, DEV_MATTER)
    : body.type === 'chase_now' ? await svc.chaseNow(DEV_TENANT, DEV_MATTER, body.waitKey as never, (body.subject as string) ?? null, DEV_USER, 'Dev User')
    : await svc.run(DEV_TENANT, DEV_MATTER, { ...body, actor: DEV_USER } as never);
  return { events: r.events.map((e) => ({ type: e.type })) };
}

export function devReset() { h = null; }
