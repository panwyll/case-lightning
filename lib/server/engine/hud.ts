/**
 * The case at a glance: the stages of the transaction, the workstreams running inside
 * each (several at once — conveyancing is concurrent), and the steps inside each
 * workstream. Every line carries one of a handful of states a conveyancer reads without
 * a key: done, waiting on someone else, ours to do, blocked, at risk, not started.
 *
 * Built from the same state the machine decides on, so it cannot disagree with it.
 */
import { requirements, workstreams, type WorkstreamStatus } from './graph';
import { profileOf } from './transactions';
import { DEFAULT_SLA } from './sla';
import { ISSUE_KIND_SPEC } from './issues';
import { isResolved, openIssues, openWaits, type MatterState, type Stage } from './types';

export type HudStatus = 'done' | 'waiting' | 'todo' | 'blocked' | 'at_risk' | 'not_started';
export interface HudStep { label: string; status: HudStatus; note: string | null }
export interface HudWorkstream { id: string; label: string; status: HudStatus; summary: string; steps: HudStep[] }
export interface HudStage { id: string; label: string; status: HudStatus; position: 'past' | 'current' | 'future'; done: number; total: number; workstreams: HudWorkstream[] }
export interface CaseHud { stages: HudStage[]; current: string }

/**
 * The macro steps a conveyancer talks in. The machine has eight stages; nobody says
 * "contract review" and "pre-exchange" as separate milestones, so they fold together here.
 */
interface Macro { id: string; label: string; stages: Stage[] }
const MACROS: Record<'buyer' | 'seller' | 'owner', Macro[]> = {
  buyer: [
    { id: 'instruction', label: 'Instruction', stages: ['instruction'] },
    { id: 'searches', label: 'Searches & enquiries', stages: ['pre_contract'] },
    { id: 'contract', label: 'Contract & exchange', stages: ['contract_review', 'pre_exchange'] },
    { id: 'pre_completion', label: 'Pre-completion', stages: ['exchanged', 'pre_completion'] },
    { id: 'completion', label: 'Completion', stages: ['completed', 'post_completion'] },
  ],
  seller: [
    { id: 'instruction', label: 'Instruction', stages: ['instruction'] },
    { id: 'contract', label: 'Contract pack', stages: ['pre_contract'] },
    { id: 'enquiries', label: 'Enquiries & exchange', stages: ['contract_review', 'pre_exchange'] },
    { id: 'pre_completion', label: 'Pre-completion', stages: ['exchanged', 'pre_completion'] },
    { id: 'completion', label: 'Completion', stages: ['completed', 'post_completion'] },
  ],
  owner: [
    { id: 'instruction', label: 'Instruction', stages: ['instruction'] },
    { id: 'investigation', label: 'Investigation', stages: ['pre_contract', 'contract_review', 'pre_exchange'] },
    { id: 'pre_completion', label: 'Pre-completion', stages: ['exchanged', 'pre_completion'] },
    { id: 'completion', label: 'Completion', stages: ['completed', 'post_completion'] },
  ],
};

/** Where each workstream sits in the transaction, by side. Anything unlisted joins the current stage. */
const BUYER: Record<string, Stage> = {
  id_aml: 'instruction', source_of_funds: 'instruction', co_ownership: 'instruction',
  searches: 'pre_contract', enquiries: 'pre_contract', survey: 'pre_contract', leasehold: 'pre_contract',
  title: 'contract_review', mortgage: 'contract_review', report_on_title: 'contract_review',
  contract: 'pre_exchange', deposit: 'pre_exchange', chain: 'pre_exchange', lender_consent: 'pre_exchange',
  completion: 'pre_completion', redemption: 'pre_completion',
  registration: 'post_completion', discharge: 'post_completion',
};
const SELLER: Record<string, Stage> = {
  id_aml: 'instruction', property_forms: 'instruction',
  title: 'pre_contract', contract: 'pre_contract',
  enquiries: 'contract_review', leasehold: 'contract_review',
  redemption: 'pre_exchange', chain: 'pre_exchange',
  completion: 'pre_completion',
  discharge: 'post_completion',
};

const WHO: Record<string, string> = { seller_solicitor: "the other side's solicitor", search_provider: 'the search provider', lender: 'the lender', client: 'the client', id_provider: 'the ID provider', hmlr: 'HM Land Registry' };
const SEARCH: Record<string, string> = { LLC1: 'Local land charges (LLC1)', CON29: 'Local authority (CON29)', DRAINAGE_WATER: 'Drainage and water', ENVIRONMENTAL: 'Environmental', CHANCEL: 'Chancel' };
const WAIT_KEY_WS: Record<string, string> = { id_check: 'id_aml', search: 'searches', enquiry: 'enquiries', funds: 'completion', registration: 'registration', proof_of_funds: 'source_of_funds', management_pack: 'leasehold', property_forms: 'property_forms', redemption: 'redemption', lender_consent: 'lender_consent', discharge: 'discharge' };

function fromWorkstream(st: WorkstreamStatus, waiting: boolean): HudStatus {
  switch (st) {
    case 'complete': return 'done';
    case 'awaiting': return 'waiting';
    case 'under_review': return 'todo';
    case 'in_progress': return waiting ? 'waiting' : 'todo';
    case 'blocked': return 'blocked';
    case 'at_risk': return 'at_risk';
    default: return 'not_started';
  }
}

const RANK: Record<HudStatus, number> = { blocked: 0, at_risk: 1, todo: 2, waiting: 3, not_started: 4, done: 5 };
const chased = (n: number) => (n === 0 ? '' : n === 1 ? ' · chased once' : ` · chased ${n} times`);

function stepsFor(s: MatterState, wsId: string, now: Date): HudStep[] {
  const out: HudStep[] = [];
  const waits = openWaits(s).filter((w) => WAIT_KEY_WS[w.key] === wsId);
  const waitFor = (key: string, subject: string) => waits.find((w) => w.key === key && w.subject === subject) ?? null;
  const waitingNote = (key: string, subject: string) => {
    const w = waitFor(key, subject);
    if (!w) return null;
    const days = Math.max(0, Math.floor((now.getTime() - new Date(w.openedAt).getTime()) / 86_400_000));
    return `waiting on ${WHO[DEFAULT_SLA[w.key]?.recipientRole ?? ''] ?? 'a third party'} · ${days}d${chased(w.chasesSentAt.length)}`;
  };

  // Items with their own life: each search, each enquiry, each source-of-funds query.
  if (wsId === 'searches') {
    for (const t of s.requiredSearches) {
      const st = s.searches[t]?.status;
      const status: HudStatus = !st ? 'not_started' : isResolved(st) ? 'done' : st === 'flagged' ? 'todo' : 'waiting';
      out.push({ label: SEARCH[t] ?? t, status, note: status === 'todo' ? 'a finding needs your decision' : status === 'waiting' ? waitingNote('search', t) ?? 'ordered' : null });
    }
    return out;
  }
  const itemised = wsId === 'enquiries' && profileOf(s.transactionType).side === 'buyer' && Object.keys(s.enquiries).length > 0;
  if (itemised) {
    for (const q of Object.values(s.enquiries)) {
      if (q.status === 'withdrawn') continue;
      const status: HudStatus = isResolved(q.status) ? 'done' : q.status === 'flagged' || q.status === 'replied' ? 'todo' : 'waiting';
      out.push({ label: `${q.enquiryId}: ${q.subject}`, status, note: status === 'todo' ? 'reply needs your review' : status === 'waiting' ? waitingNote('enquiry', q.enquiryId) : null });
    }
  }
  if (wsId === 'source_of_funds') {
    for (const q of Object.values(s.proofOfFunds.queries)) {
      if (q.status === 'withdrawn' || q.status === 'draft') continue;
      out.push({ label: q.question.length > 90 ? `${q.question.slice(0, 89)}…` : q.question, status: q.status === 'answered' ? 'done' : 'waiting', note: q.status === 'sent' ? 'waiting on the client' : null });
    }
  }

  // The requirements this workstream must satisfy, with what stands in the way.
  for (const r of requirements(s)) {
    if (!r.applies || r.workstream !== wsId) continue;
    if (itemised) continue;
    if (r.satisfied) { out.push({ label: r.label, status: 'done', note: null }); continue; }
    const b = r.blockedBy;
    const issue = b.find((x) => x.type === 'issue');
    const decision = b.find((x) => x.type === 'decision');
    const wait = b.find((x) => x.type === 'wait' || x.type === 'client');
    const status: HudStatus = issue ? 'blocked' : decision ? 'todo' : wait ? 'waiting' : 'not_started';
    const open = waits[0];
    const note = issue ? issue.label : decision ? 'your decision' : wait ? (wait.type === 'client' ? 'waiting on the client' : open ? waitingNote(open.key, open.subject) : wait.label) : b[0]?.label ?? null;
    out.push({ label: r.label, status, note });
  }

  // Open issues on this workstream that no requirement line already names.
  const named = new Set(out.map((x) => x.note).filter(Boolean));
  for (const i of openIssues(s)) {
    if (!ISSUE_KIND_SPEC[i.kind].workstreams.includes(wsId as never)) continue;
    if ([...named].some((n) => (n as string).includes(i.title.slice(0, 30)))) continue;
    out.push({ label: i.title, status: i.gate !== 'none' ? 'blocked' : 'at_risk', note: null });
  }
  return out;
}

export function caseHud(s: MatterState, now: Date = new Date()): CaseHud {
  const p = profileOf(s.transactionType);
  const where = p.side === 'seller' ? SELLER : BUYER;
  const macros = MACROS[p.side as keyof typeof MACROS] ?? MACROS.buyer;
  const macroOf = (st: Stage) => Math.max(0, macros.findIndex((m) => m.stages.includes(st)));
  const currentIdx = macroOf(s.stage);
  const reqWs = new Set(requirements(s).filter((r) => r.applies && r.workstream).map((r) => r.workstream as string));
  const ws = workstreams(s, now).filter((w) => w.status !== 'not_applicable' || reqWs.has(w.id));
  const stages: HudStage[] = macros.map((m, i) => ({
    id: m.id,
    label: m.label,
    status: 'not_started' as HudStatus,
    position: i < currentIdx ? 'past' : i === currentIdx ? 'current' : 'future',
    done: 0,
    total: 0,
    workstreams: [],
  }));
  for (const w of ws) {
    const stage = stages[where[w.id] ? macroOf(where[w.id]) : currentIdx];
    const status = fromWorkstream(w.status, w.waits.length > 0);
    // A wait that has had to be chased is not just "waiting": it is slipping.
    const slipping = status === 'waiting' && w.waits.some((x) => x.chases > 0);
    stage.workstreams.push({ id: w.id, label: w.label, status: slipping ? 'at_risk' : status, summary: w.detail, steps: stepsFor(s, w.id, now) });
  }
  for (const [i, st] of stages.entries()) {
    st.total = st.workstreams.length;
    st.done = st.workstreams.filter((w) => w.status === 'done').length;
    st.workstreams.sort((a, b) => RANK[a.status] - RANK[b.status]);
    if (st.total === 0) st.status = i < currentIdx ? 'done' : 'not_started';
    else if (st.done === st.total) st.status = 'done';
    else st.status = st.workstreams.reduce<HudStatus>((worst, w) => (RANK[w.status] < RANK[worst] ? w.status : worst), 'done');
    // A stage nobody has touched yet is "not started", not "to do".
    if (st.status === 'todo' && i > currentIdx && st.workstreams.every((w) => w.status === 'not_started' || w.status === 'todo' && w.steps.every((x) => x.status === 'not_started'))) st.status = 'not_started';
  }
  return { stages, current: stages[currentIdx].id };
}
