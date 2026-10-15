/**
 * The onboarding measurement (docs/epa-categories.md, "The measurement phase"): from each conveyancer's mailbox scan and
 * InTouch, a typical week for the firm in the same categories and colours as Analytics → Time. Pure; the route loads.
 *
 * The same model as the live page (docs/epa.md §2): every sent email and every document or note the firm filed in InTouch is an
 * action at a time; the time before an action is that kind of work, capped by what that work takes (ledger.ts). Outlook's own
 * draft-to-send time is writing, where it has one. Every received email is reading time, of the kind it is, when it arrived. So
 * green is measured, not assumed: the time before legal emails and before the legal documents the firm filed. What no action
 * accounts for is Not Seen (calls, meetings, files read without an email after) and is shown as such, never counted as green.
 *
 * Below MIN_SENT_PER_WEEK case emails sent a week per person the page warns that not much data was found (it still draws it).
 */
import { actsUnasked, levelFor, ENGINE_ACTION_LABEL, type LevelConfig } from '../engine/types';
import { timedMinutes } from '../workload/model';
import { attribute, completionSpans, DEFAULT_LUNCH, measure, type Completion, type Span } from './ledger';
import { ACTION_FOR, weekStart, type ParetoBar, type RagSplit } from './report';
import { EPA_KINDS, EPA_SPEC, fromEmail, type EpaKind } from './taxonomy';

/** Below this many case emails sent a week per person, the page warns that not much data was found. */
export const MIN_SENT_PER_WEEK = 20;

/** Reading a received email, by what it is: minutes. */
export const READ_MINUTES: Record<string, number> = {
  update_request: 1, chaser_received: 1, document_delivery: 1.5, question: 2, instruction: 2, enquiry: 4, other: 0.5,
};

export interface ScanEmail { id: string; at: number; draftedAt: number | null; category: string; roles: string[] }
export interface PersonScan {
  weeks: number;
  sent: ScanEmail[];
  received: ScanEmail[];
  intouch: { live: number; openedInWindow: number; items?: Array<{ at: string; kind: string }>; error?: string | null } | null;
}

export interface Measurement {
  people: number;
  contractedHours: number;
  /** A typical week for the whole firm: measured red, amber and green, and what nothing accounts for. */
  hours: RagSplit & { unseen: number };
  /** Shares of the whole contracted week, Not Seen included. */
  share: RagSplit & { unseen: number };
  /** Green ÷ everything seen. */
  efficiencySeen: number | null;
  /** Red and amber, biggest first: hours, how many a week, minutes each, and the action that takes it. */
  lines: ParetoBar[];
  /** Case email sent a week per person: below MIN_SENT_PER_WEEK the page warns. */
  sentPerPersonWeek: number;
  /** What causes the red, a week: status requests and chasers received. */
  received: { clientStatusRequests: number; agentStatusRequests: number; otherSideStatusRequests: number; chasersReceived: number };
  /** From InTouch, when it was read. */
  cases: { live: number; perConveyancer: number | null; openedPerWeek: number | null } | null;
}

const WEEK_MS = 7 * 86_400_000;
const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;
const isKind = (k: string): k is EpaKind => (EPA_KINDS as readonly string[]).includes(k);

/** One person's evidence as spans: actions, writing, reading. */
function spansOf(p: PersonScan, workday: { workdayStart: string; workdayEnd: string }): Span[] {
  const done: Completion[] = [];
  const spans: Span[] = [];
  for (const e of p.sent) {
    const kind = fromEmail(e.category, e.roles);
    if (EPA_SPEC[kind].rag === 'none') continue;
    done.push({ at: e.at, item: `out:${e.id}`, kind });
    const t = e.draftedAt ? timedMinutes({ draftedAt: new Date(e.draftedAt).toISOString(), sentAt: new Date(e.at).toISOString() }) : null;
    if (t != null) spans.push({ start: e.at - t * 60_000, end: e.at, item: `out:${e.id}`, kind, source: 'compose' });
  }
  for (const i of p.intouch?.items ?? []) {
    const at = Date.parse(i.at);
    if (isKind(i.kind) && Number.isFinite(at)) done.push({ at, item: `it:${i.at}:${i.kind}`, kind: i.kind });
  }
  spans.push(...completionSpans(done, { ...workday, ...DEFAULT_LUNCH }));
  // Reading: the weakest evidence, so it only fills time nothing stronger accounts for.
  for (const e of p.received) {
    const kind = fromEmail(e.category, e.roles);
    const mins = READ_MINUTES[e.category] ?? 0;
    if (EPA_SPEC[kind].rag === 'none' || !mins) continue;
    spans.push({ start: e.at, end: e.at + mins * 60_000, item: `in:${e.id}`, kind, source: 'estimate' });
  }
  return spans;
}

export function buildMeasurement(input: { people: PersonScan[]; contractedHours: number; levels: LevelConfig; workday?: { workdayStart: string; workdayEnd: string } }): Measurement | null {
  const scanned = input.people.filter((p) => p.weeks > 0);
  if (!scanned.length) return null;
  const workday = input.workday ?? { workdayStart: '09:00', workdayEnd: '17:30' };
  // Per kind, firm-wide, a week: minutes and how many separate things.
  const minutes = new Map<EpaKind, number>();
  const things = new Map<EpaKind, number>();
  let unseen = 0;
  let sentCase = 0;
  const received = { clientStatusRequests: 0, agentStatusRequests: 0, otherSideStatusRequests: 0, chasersReceived: 0 };
  let live = 0;
  let opened = 0;
  let intouchPeople = 0;
  for (const p of scanned) {
    const spans = spansOf(p, workday);
    sentCase += p.sent.filter((e) => EPA_SPEC[fromEmail(e.category, e.roles)].rag !== 'none').length / p.weeks;
    let seen = 0;
    // Week by week: each person's time attributed on their own timeline, cut at Monday so nothing counts twice.
    if (spans.length) {
      const first = Math.min(...spans.map((s) => s.start));
      const last = Math.max(...spans.map((s) => s.end));
      for (let w = weekStart(first); w <= last; w += WEEK_MS) {
        const inWeek = spans.filter((s) => s.end > w && s.start < w + WEEK_MS).map((s) => ({ ...s, start: Math.max(s.start, w), end: Math.min(s.end, w + WEEK_MS) }));
        if (!inWeek.length) continue;
        const slices = attribute(inWeek);
        const m = measure(slices, workday, undefined, { afterHours: false });
        const items = new Map<EpaKind, Set<string>>();
        for (const sl of slices) {
          if (!items.has(sl.span.kind)) items.set(sl.span.kind, new Set());
          items.get(sl.span.kind)!.add(sl.span.item);
        }
        for (const k of EPA_KINDS) {
          if (EPA_SPEC[k].rag === 'none' || !m.minutes[k]) continue;
          minutes.set(k, (minutes.get(k) ?? 0) + m.minutes[k] / p.weeks);
          // How many times: the actions (a status request read then answered is once), else the reads where there was no action.
          const ids = [...(items.get(k) ?? [])];
          const acts = ids.filter((id) => !id.startsWith('in:')).length;
          things.set(k, (things.get(k) ?? 0) + (acts || ids.length) / p.weeks);
          seen += m.minutes[k] / p.weeks;
        }
      }
    }
    unseen += Math.max(0, input.contractedHours * 60 - seen);
    for (const e of p.received) {
      const role = new Set(e.roles);
      if (e.category === 'update_request') {
        if (role.has('client')) received.clientStatusRequests += 1 / p.weeks;
        else if (role.has('estate_agent')) received.agentStatusRequests += 1 / p.weeks;
        else received.otherSideStatusRequests += 1 / p.weeks;
      }
      if (e.category === 'chaser_received') received.chasersReceived += 1 / p.weeks;
    }
    if (p.intouch && !p.intouch.error) { intouchPeople += 1; live += p.intouch.live; opened += p.intouch.openedInWindow / p.weeks; }
  }

  const h = { red: 0, amber: 0, green: 0 };
  for (const [k, v] of minutes) { const rag = EPA_SPEC[k].rag; if (rag !== 'none') h[rag] += v / 60; }
  const total = h.red + h.amber + h.green + unseen / 60;
  const routine = EPA_KINDS.filter((k) => (EPA_SPEC[k].rag === 'red' || EPA_SPEC[k].rag === 'amber') && (minutes.get(k) ?? 0) > 0).sort((a, b) => minutes.get(b)! - minutes.get(a)!);
  const routineMinutes = routine.reduce((a, k) => a + minutes.get(k)!, 0);
  let cum = 0;
  const lines: ParetoBar[] = routine.map((k) => {
    const mins = minutes.get(k)!;
    const n = things.get(k) ?? 0;
    cum += mins;
    const key = ACTION_FOR[k];
    const level = key ? levelFor(input.levels, key) : null;
    return {
      kind: k, label: EPA_SPEC[k].label, rag: EPA_SPEC[k].rag as 'red' | 'amber', hours: r2(mins / 60), share: mins / routineMinutes, cumulative: cum / routineMinutes,
      times: Math.round(n), avgMinutes: n ? r1(mins / n) : null,
      action: key && level ? { key, label: ENGINE_ACTION_LABEL[key], level, sendsUnasked: actsUnasked(level, key) } : null,
    };
  });
  const seenH = h.red + h.amber + h.green;
  return {
    people: scanned.length,
    contractedHours: input.contractedHours,
    hours: { red: r1(h.red), amber: r1(h.amber), green: r1(h.green), unseen: r1(unseen / 60) },
    share: total ? { red: h.red / total, amber: h.amber / total, green: h.green / total, unseen: unseen / 60 / total } : { red: 0, amber: 0, green: 0, unseen: 1 },
    efficiencySeen: seenH ? h.green / seenH : null,
    lines,
    sentPerPersonWeek: r1(sentCase / scanned.length),
    received: { clientStatusRequests: Math.round(received.clientStatusRequests), agentStatusRequests: Math.round(received.agentStatusRequests), otherSideStatusRequests: Math.round(received.otherSideStatusRequests), chasersReceived: Math.round(received.chasersReceived) },
    cases: intouchPeople ? { live, perConveyancer: r1(live / intouchPeople), openedPerWeek: r1(opened) } : null,
  };
}
