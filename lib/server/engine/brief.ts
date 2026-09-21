/**
 * The case brief — one structured account of a matter that every outward-facing feature
 * reads (docs/architecture-review.md §15).
 *
 * Before this, each feature re-derived the same facts its own way: the drafter from RAG
 * chunks, the client channel from a static FAQ, the status update from an event payload.
 * That is how three surfaces end up telling a client three different things. Now the
 * engine's state is rendered once, in two registers:
 *
 *   renderForDrafting(brief) — everything, for a fee-earner's own draft.
 *   clientStatusAnswer(brief) — process facts only, and ONLY when it is safe to answer
 *                               automatically at all. Anything with a live legal problem
 *                               in it is not answered by a machine; it goes to a person.
 *
 * Pure in (state, now).
 */
import { ISSUE_KIND_SPEC, type Workstream } from './issues';
import { caseHealth, type CaseHealth, type HealthBand } from './health';
import { lifecycle, workstreams, nextActions, LIFECYCLE_LABEL, type Lifecycle, type WorkstreamStatus } from './graph';
import { openIssues, openWaits, pendingDecisions, type MatterState } from './types';
import { profileOf } from './transactions';
import { DEFAULT_SLA } from './sla';
import { EW_CALENDAR, workingDaysBetween, type WorkingCalendar } from './working-days';

/** Who we are waiting on, in words a client would recognise. Never a firm's name. */
const PARTY: Record<string, string> = {
  seller_solicitor: "the seller's solicitor",
  search_provider: 'the local authority and search providers',
  lender: 'your lender',
  client: 'you',
  id_provider: 'our identity checking provider',
  hmlr: 'HM Land Registry',
};
/** What we are waiting FOR, in the same register. */
const SUBJECT: Record<string, string> = {
  search: 'a property search',
  enquiry: 'replies to our enquiries',
  id_check: 'your identity check',
  funds: 'completion funds',
  registration: 'registration',
  proof_of_funds: 'your proof of funds',
  management_pack: 'the management pack from the freeholder',
  property_forms: 'your property information forms',
  redemption: 'a redemption statement',
  lender_consent: "your lender's consent",
  discharge: 'evidence that the old mortgage is discharged',
};

export interface BriefWait {
  key: string;
  subject: string;
  /** Client-facing description ("a property search") — never an internal code. */
  what: string;
  /** The same thing for internal use, with the code a fee-earner needs ("a property search (CON29)"). */
  detail: string;
  who: string;
  role: string;
  sinceWorkingDays: number;
  sinceCalendarDays: number;
  chasesSent: number;
  lastChasedDaysAgo: number | null;
  chaseInWorkingDays: number | null;
  escalated: boolean;
}

export interface CaseBrief {
  matterId: string;
  enrolled: boolean;
  transactionType: string;
  transactionLabel: string;
  side: 'buyer' | 'seller' | 'owner';
  stage: string;
  lifecycle: Lifecycle;
  lifecycleLabel: string;
  dayOfCase: number;
  health: { band: HealthBand; headline: string | null };
  workstreams: Array<{ id: Workstream; label: string; status: WorkstreamStatus; detail: string }>;
  /** Everything outstanding with someone else, with its clock. */
  waiting: BriefWait[];
  /** Open issues — the legal problems. NEVER shown to a client by the automated channel. */
  issues: Array<{ id: string; kind: string; label: string; title: string; gate: string; severity: string }>;
  decisionsPending: Array<{ kind: string; subject: string | null }>;
  nextActions: Array<{ what: string; who: string; unblocks: string }>;
  milestones: {
    exchangedAt: string | null;
    completionDate: string | null;
    completedAt: string | null;
    targetExchangeDate: string | null;
    targetCompletionDate: string | null;
    reportOnTitleSentAt: string | null;
  };
  /** Client decisions already recorded, so nothing asks twice. */
  clientDecisions: Array<{ subject: string; decision: string; at: string }>;
}

const calDays = (iso: string, now: Date) => Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000));

export function caseBrief(s: MatterState, now: Date = new Date(), cal: WorkingCalendar = EW_CALENDAR): CaseBrief {
  const p = profileOf(s.transactionType);
  const health: CaseHealth = caseHealth(s, now);
  const lc = lifecycle(s);
  const waiting: BriefWait[] = openWaits(s).map((w) => {
    const rule = DEFAULT_SLA[w.key];
    const chases = w.chasesSentAt.length;
    const last = chases ? w.chasesSentAt[chases - 1] : null;
    const age = workingDaysBetween(new Date(w.openedAt), now, cal);
    return {
      key: w.key,
      subject: w.subject,
      what: SUBJECT[w.key] ?? w.key.replace(/_/g, ' '),
      detail: `${SUBJECT[w.key] ?? w.key.replace(/_/g, ' ')}${w.subject ? ` (${w.subject})` : ''}`,
      who: PARTY[rule?.recipientRole ?? ''] ?? 'a third party',
      role: rule?.recipientRole ?? 'third_party',
      sinceWorkingDays: age,
      sinceCalendarDays: calDays(w.openedAt, now),
      chasesSent: chases,
      lastChasedDaysAgo: last ? calDays(last, now) : null,
      chaseInWorkingDays: !rule ? null : !last ? rule.chaseAfter - age : rule.chaseEvery === null ? null : rule.chaseEvery - workingDaysBetween(new Date(last), now, cal),
      escalated: w.escalations.some((e) => !e.resolvedAt),
    };
  });

  return {
    matterId: s.matterId,
    enrolled: s.enrolled,
    transactionType: s.transactionType ?? 'freehold_purchase',
    transactionLabel: p.label,
    side: p.side,
    stage: s.stage,
    lifecycle: lc,
    lifecycleLabel: LIFECYCLE_LABEL[lc] ?? lc,
    dayOfCase: s.stageHistory.length ? calDays(s.stageHistory[0].at, now) : 0,
    health: { band: health.band, headline: health.reasons[0]?.headline ?? null },
    workstreams: workstreams(s, now).map((w) => ({ id: w.id, label: w.label, status: w.status, detail: w.detail })),
    waiting,
    issues: openIssues(s).map((i) => ({ id: i.id, kind: i.kind, label: ISSUE_KIND_SPEC[i.kind]?.label ?? i.kind, title: i.title, gate: i.gate, severity: i.severity })),
    decisionsPending: pendingDecisions(s).filter((d) => d.kind !== 'auto_clear').map((d) => ({ kind: d.kind, subject: d.subject })),
    nextActions: nextActions(s, now).slice(0, 6).map((a) => ({ what: a.what, who: a.who, unblocks: a.unblocks })),
    milestones: {
      exchangedAt: s.exchange.exchangedAt,
      completionDate: s.exchange.completionDate,
      completedAt: s.completion.confirmedAt,
      targetExchangeDate: s.targetExchangeDate,
      targetCompletionDate: s.targetCompletionDate,
      reportOnTitleSentAt: s.reportOnTitle.sentAt,
    },
    clientDecisions: Object.entries(s.clientDecisions).filter(([, v]) => !!v).map(([subject, v]) => ({ subject, decision: v!.decision, at: v!.at })),
  };
}

// ───────────────────────────── for a fee-earner's draft ─────────────────────────────

/**
 * The full brief as text, for the email drafter. This is internal: it names issues,
 * decisions and dates, because the person writing has the authority to use them.
 */
export function renderForDrafting(b: CaseBrief): string {
  const L: string[] = [];
  L.push(`CASE STATE (from the conveyancing engine — these are facts, use them instead of guessing):`);
  L.push(`- ${b.transactionLabel}, ${b.lifecycleLabel.toLowerCase()}, day ${b.dayOfCase}.`);
  L.push(`- Workstreams: ${b.workstreams.filter((w) => w.status !== 'not_applicable').map((w) => `${w.label} ${w.status.replace(/_/g, ' ')}`).join('; ')}.`);
  if (b.waiting.length) {
    L.push(`- Outstanding with others:`);
    for (const w of b.waiting) {
      L.push(`    · ${w.detail} — with ${w.who}, ${w.sinceWorkingDays} working days, ${w.chasesSent} chase${w.chasesSent === 1 ? '' : 's'} sent${w.escalated ? ', ESCALATED' : ''}.`);
    }
  } else L.push('- Nothing is outstanding with a third party.');
  if (b.issues.length) {
    L.push(`- Open issues:`);
    for (const i of b.issues) L.push(`    · ${i.id} ${i.label}: ${i.title} (${i.gate === 'none' ? 'holds nothing' : `holds ${i.gate}`}, ${i.severity}).`);
  }
  if (b.decisionsPending.length) L.push(`- Waiting on a decision from us: ${b.decisionsPending.map((d) => d.kind.replace(/_/g, ' ')).join(', ')}.`);
  const m = b.milestones;
  const dates = [m.exchangedAt && `exchanged ${m.exchangedAt.slice(0, 10)}`, m.completionDate && `completion ${m.completionDate}`, !m.exchangedAt && m.targetExchangeDate && `target exchange ${m.targetExchangeDate}`, m.reportOnTitleSentAt && `report on title sent ${m.reportOnTitleSentAt.slice(0, 10)}`].filter(Boolean);
  if (dates.length) L.push(`- Dates: ${dates.join('; ')}.`);
  if (b.clientDecisions.length) L.push(`- The client has already decided: ${b.clientDecisions.map((d) => `${d.subject.replace(/_/g, ' ')} = ${d.decision.replace(/_/g, ' ')}`).join('; ')}.`);
  if (b.nextActions.length) L.push(`- Next steps the engine is tracking: ${b.nextActions.map((a) => a.what).join('; ')}.`);
  L.push('Do not state anything about this matter that is not above or in the thread.');
  return L.join('\n');
}

// ───────────────────────────── for the client, automatically ─────────────────────────────

export type ClientStatus =
  | { canAnswer: true; text: string; facts: string[] }
  | { canAnswer: false; reason: string };

const when = (days: number | null): string => (days === null ? '' : days === 0 ? 'today' : days === 1 ? 'yesterday' : days <= 7 ? `${days} days ago` : 'recently');
const soon = (wd: number | null): string => (wd === null ? '' : wd <= 0 ? 'again shortly' : wd === 1 ? 'again tomorrow' : `again in ${wd} working days`);
const list = (xs: string[]): string => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/**
 * "Any update?" answered from the case itself (docs/architecture-review.md §10).
 *
 * Deliberately deterministic — no model writes this. The automated channel may describe
 * PROCESS (what is done, what is outstanding, who has it, when we last chased and when we
 * chase next) and nothing else. It refuses entirely whenever the matter contains anything
 * that needs professional judgement, because a reassuring machine-written summary is
 * exactly the wrong thing to send on a case with a live legal problem on it.
 */
export function clientStatusAnswer(b: CaseBrief, now: Date = new Date()): ClientStatus {
  if (!b.enrolled) return { canAnswer: false, reason: 'the matter is not run by the engine' };
  if (b.side !== 'buyer' && b.side !== 'seller' && b.side !== 'owner') return { canAnswer: false, reason: 'unknown side' };
  // Refuse on anything a person should be saying.
  const blocking = b.issues.filter((i) => i.gate !== 'none');
  if (blocking.length) return { canAnswer: false, reason: `an open issue holds ${blocking[0].gate}` };
  if (b.issues.some((i) => i.severity === 'critical')) return { canAnswer: false, reason: 'a critical issue is open' };
  if (b.decisionsPending.some((d) => d.kind === 'bank_details')) return { canAnswer: false, reason: 'a payment hard stop is open' };
  if (b.health.band === 'critical' || b.health.band === 'blocked') return { canAnswer: false, reason: `the case reads ${b.health.band}` };
  if (b.milestones.completedAt) return { canAnswer: false, reason: 'the matter has completed — say so personally' };

  const facts: string[] = [];
  const parts: string[] = [];

  // What is done.
  const done = b.workstreams.filter((w) => w.status === 'complete').map((w) => w.label.toLowerCase());
  if (done.length) {
    parts.push(`On your file, ${list(done)} ${done.length === 1 ? 'is' : 'are'} complete.`);
    facts.push(`complete: ${done.join(', ')}`);
  }

  // What the client owes us — the only thing they are asked to act on.
  const onClient = b.waiting.filter((w) => w.role === 'client');
  const onOthers = b.waiting.filter((w) => w.role !== 'client');

  if (onOthers.length) {
    const byWho = new Map<string, BriefWait[]>();
    for (const w of onOthers) byWho.set(w.who, [...(byWho.get(w.who) ?? []), w]);
    for (const [who, ws] of byWho) {
      const kinds = Array.from(new Set(ws.map((w) => w.what)));
      const what = kinds.length === 1 ? (ws.length === 1 ? kinds[0] : `${ws.length} of them`) : list(kinds);
      parts.push(`We are waiting for ${who} to come back to us on ${what}.`);
      facts.push(`waiting on ${who}: ${ws.map((w) => w.what).join(', ')}`);
      const chased = ws.filter((w) => w.chasesSent > 0).sort((a, b2) => (a.lastChasedDaysAgo ?? 99) - (b2.lastChasedDaysAgo ?? 99))[0];
      if (chased) {
        const next = ws.map((w) => w.chaseInWorkingDays).filter((n): n is number => n !== null).sort((a, b2) => a - b2)[0] ?? null;
        parts.push(`We chased ${when(chased.lastChasedDaysAgo)}${next !== null ? ` and will follow up ${soon(next)} if we have not heard` : ''}.`);
        facts.push(`last chased ${chased.lastChasedDaysAgo}d ago, ${chased.chasesSent} sent`);
      }
    }
  }

  if (onClient.length) {
    parts.push(`We do still need ${list(onClient.map((w) => w.what))} from you — that is the one thing holding us up at your end.`);
    facts.push(`from the client: ${onClient.map((w) => w.what).join(', ')}`);
  } else {
    parts.push('There is nothing you need to do at the moment.');
  }

  if (!parts.length) return { canAnswer: false, reason: 'nothing meaningful to say' };
  if (b.milestones.exchangedAt && b.milestones.completionDate) {
    parts.unshift('Contracts are exchanged and we are working towards the agreed completion date.');
    facts.push('exchanged');
  }
  parts.push('If you would like to talk anything through, just say and your conveyancer will call you.');
  void now;
  return { canAnswer: true, text: parts.join(' '), facts };
}
