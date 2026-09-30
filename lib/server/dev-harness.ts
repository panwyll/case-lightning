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
import { COMPLETION_CONTRACTS } from './engine/completion';

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
  await run({ type: 'raise_issue', kind: 'transaction_at_risk', title: 'The agent says the buyer may be pulling out', detail: 'Agent phoned: the buyer has lost their job and is reconsidering.' });
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
    contracts: COMPLETION_CONTRACTS,
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

/** An issue's message step: the draft, then the send (the mock chaser receives it). */
export async function devIssueDraft(issueId: string, step: string) {
  const { svc } = await devHarness();
  return svc.draftIssueMessage(DEV_TENANT, DEV_MATTER, issueId, step);
}
export async function devIssueSend(issueId: string, body: { to: never; subject: string; body: string }) {
  const { svc } = await devHarness();
  const r = await svc.sendIssueMessage(DEV_TENANT, DEV_MATTER, issueId, { actor: DEV_USER, to: body.to, subject: body.subject, body: body.body });
  return { events: r.events.length };
}

/** The fake email the #thread view opens (GET matters/:id/emails/thread). */
export const DEV_EMAIL_DOC = '44444444-4444-4444-8444-444444444444';

/** A client ↔ us conversation: one message recovered from quoted history, one attachment, the newest raised the task. */
export function devEmailThread() {
  const at = (daysAgo: number, h: number, m: number) => { const d = new Date(); d.setDate(d.getDate() - daysAgo); d.setHours(h, m, 0, 0); return d.toISOString(); };
  const jane = { name: 'Jane Smith', address: 'jane.smith@example.com' };
  const alex = { name: 'Alex Carter', address: 'alex@yourfirm.co.uk' };
  const subject = 'Re: 14 Oak Street, Leeds – contract for signature';
  return {
    subject: '14 Oak Street, Leeds – contract for signature',
    messages: [
      { id: 'quoted-1', documentId: null, from: jane, to: [alex], cc: [], date: at(3, 16, 40), subject: '14 Oak Street, Leeds – contract for signature', body: 'Hi Alex,\n\nThe estate agent says the buyer is ready to go. When do I need to sign the contract, and do I need to come into the office?\n\nThanks,\nJane', attachments: [], mine: false, quoted: true },
      { id: '44444444-4444-4444-8444-444444444441', documentId: '44444444-4444-4444-8444-444444444441', from: alex, to: [jane], cc: [], date: at(2, 10, 2), subject, body: 'Hi Jane,\n\nNo need to come in. I will send the contract and transfer deed for signature once the buyer\'s solicitors have approved the draft, which they expect to do this week.\n\nKind regards,\nAlex Carter', attachments: [], mine: true, quoted: false },
      { id: '44444444-4444-4444-8444-444444444442', documentId: '44444444-4444-4444-8444-444444444442', from: jane, to: [alex], cc: [{ name: 'Tom Smith', address: 'tom.smith@example.com' }], date: at(2, 12, 15), subject, body: 'Great, thank you. Tom is copied in as he will need to sign too.', attachments: [], mine: false, quoted: false },
      { id: '44444444-4444-4444-8444-444444444443', documentId: '44444444-4444-4444-8444-444444444443', from: alex, to: [jane], cc: [{ name: 'Tom Smith', address: 'tom.smith@example.com' }], date: at(1, 9, 30), subject, body: 'Hi Jane and Tom,\n\nThe draft is approved. Please sign the contract where marked, have your signatures witnessed on the TR1, and send both back to me. Do not date either document.\n\nKind regards,\nAlex Carter', attachments: [], mine: true, quoted: false },
      { id: DEV_EMAIL_DOC, documentId: DEV_EMAIL_DOC, from: jane, to: [alex], cc: [{ name: 'Tom Smith', address: 'tom.smith@example.com' }], date: at(0, 8, 45), subject, body: 'Hi Alex,\n\nSigned contract attached. The TR1 is in the post today, witnessed by our neighbour. Is there anything else you need from us before exchange?\n\nJane', attachments: [{ name: 'Signed contract – 14 Oak Street.pdf', documentId: '55555555-5555-4555-8555-555555555555' }], mine: false, quoted: false },
    ],
  };
}

/**
 * A client's compound email as a real task on the harness case: read by the engine (the rule-based
 * reader, the reply built from the case facts) exactly as production would, so the Decision view's
 * lines, reply editor and conversation can be checked. Its source is shown as DEV_EMAIL_DOC's thread.
 */
const emailTasks = new WeakMap<object, string>();
const EMAIL_TEXT = "Hi Alex,\n\nThe agent says the buyer is threatening to pull out unless we complete by Friday. Can you resend the property forms link? Is that possible?\n\nJane";
export async function devEmailTask(): Promise<string> {
  const hh = await devHarness();
  const { svc, ports } = hh;
  const known = emailTasks.get(hh);
  if (known) return known;
  const { DeterministicNoteReader } = await import('./engine/notes');
  ports.noteExtractor = new DeterministicNoteReader();
  const documentId = ports.documents.seed({ tenantId: DEV_TENANT, matterId: DEV_MATTER, docType: 'EMAIL', extractedFacts: { content: EMAIL_TEXT } }).id;
  const res = await svc.recordNote(DEV_TENANT, DEV_MATTER, { text: EMAIL_TEXT, kind: 'email', actor: DEV_USER, documentId, from: { address: 'jane.smith@example.com', name: 'Jane Smith', relation: 'client' }, surface: true, subject: '14 Oak Street, Leeds – contract for signature' });
  const id = Object.values(res.state.notes).find((n) => n.documentId === documentId)?.decisionEventId ?? null;
  if (!id) throw new Error('The harness email raised no task.');
  emailTasks.set(hh, id);
  return id;
}

/** GET decisions/:id for the harness: the same shape the real route returns, for a note decision. */
export async function devDecision(eventId: string) {
  const { svc } = await devHarness();
  const { effectText, effectChanges, noteTaskTitle, replyTitle } = await import('./engine/notes');
  const { isJeopardy } = await import('./engine/health');
  const { offeredOptions } = await import('./engine/rules');
  const state = await svc.getState(DEV_TENANT, DEV_MATTER);
  const d = state.decisions[eventId];
  if (!d) return null;
  const note = Object.values(state.notes).find((n) => n.decisionEventId === eventId) ?? null;
  const events = await svc.listEvents(DEV_TENANT, DEV_MATTER);
  const applied = events.find((e) => e.type === 'note_actions_applied' && (e.payload as { decisionEventId?: string }).decisionEventId === eventId);
  const ap = applied?.payload as { applied: string[]; skipped: string[]; messages?: Array<{ id: string; to: string; subject: string; body: string }> } | undefined;
  return {
    context: null,
    noteActions: note ? { title: note.messages?.length || note.reply ? replyTitle(note.from) : noteTaskTitle(note.actions), noteId: note.id, noteKind: note.kind, actions: note.actions.map((a) => ({ id: a.id, kind: a.kind, summary: a.summary, quote: a.quote, confidence: a.confidence, effect: a.command ? effectText(a.command, { withMessages: !!note.messages?.length }) : null, changes: a.command ? effectChanges(a.command, { jeopardy: isJeopardy }) : [] })), applied: ap?.applied ?? null, skipped: ap?.skipped ?? null, refused: note.refusedActions ?? [], messages: note.messages ?? [], messagesSent: ap?.messages ?? null } : null,
    message: null, openQueries: 0,
    decision: { ...d, tenantId: DEV_TENANT, matterId: DEV_MATTER, options: offeredOptions(d.kind, d.options), sourceOpenedByMe: d.openedBy.includes(DEV_USER) },
    matter: { matterRef: 'DEV-001', propertyAddress: '14 Oak Street, Leeds LS1 2AB', shadowMode: false },
    raised: null, resolution: applied ? { eventId: applied.id, type: applied.type, by: DEV_USER, at: applied.createdAt, option: 'approve', note: null, engagement: null, verification: null } : null,
    escalation: null, opens: [], people: {}, shadowed: null,
    source: d.status === 'pending' ? null : devEmailSource(),
  };
}
const devEmailSource = () => ({ id: DEV_EMAIL_DOC, fileName: 'email-2026-09-30-contract-for-signature.txt', webUrl: null, docType: 'EMAIL', content: `From: Jane Smith <jane.smith@example.com>\nTo: alex@yourfirm.co.uk\nDate: ${new Date().toISOString()}\nSubject: Re: 14 Oak Street, Leeds – contract for signature\n\n${EMAIL_TEXT}`, rawUrl: null });
export async function devOpenSource(eventId: string) {
  const { svc } = await devHarness();
  await svc.openDecisionSource(DEV_TENANT, DEV_MATTER, eventId, DEV_USER).catch(() => {});
  return { document: devEmailSource(), locator: null };
}
export async function devResolve(eventId: string, body: { option: string; note?: string | null; selection?: string[] | null; edited?: { subject?: string | null; body?: string | null } | null }) {
  const { svc } = await devHarness();
  await svc.resolveDecision(DEV_TENANT, DEV_MATTER, eventId, DEV_USER, body.option as never, body.note ?? null, null, null, body.selection ?? null, body.edited ?? null);
  return { ok: true };
}
